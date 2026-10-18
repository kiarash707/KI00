import type { AgentEvent, FreeModel } from "../../shared/types";
import type { Env } from "../env";
import type { ChatMessage, ToolCall } from "./openrouter";
import { OpenRouterClient, fallbackModels } from "./openrouter";
import { getModelCatalog } from "./models";
import { dbAll, dbFirst, dbRun } from "./db";
import { newId, now, truncate } from "./utils";
import { AGENT_TOOLS, PRIVILEGED_TOOLS, approvalPreview, executeReadTool } from "./agent-tools";
import type { ToolContext } from "./agent-tools";

export const MAX_MODEL_CALLS = 8;
const MAX_TOOL_CALLS = 12;
const MAX_TOOLS_PER_TURN = 4;

export interface AgentRunInput {
  threadId?: string | null;
  projectId?: string | null;
  message: string;
  model?: string | null;
}

export interface AgentActor {
  workspaceId: string;
  userId: string;
  userEmail: string;
}

interface ConversationEntry {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/**
 * Runs a bounded tool-calling loop against an OpenRouter FREE model.
 * Every tool result is a real KI00/Cloudflare/GitHub response. There is no
 * synthetic log or deployment data, and there is no automatic paid fallback.
 */
export async function runAgent(
  env: Env,
  actor: AgentActor,
  input: AgentRunInput,
  emit: (event: AgentEvent) => void
): Promise<void> {
  const catalog = await getModelCatalog(env);
  if (!env.OPENROUTER_API_KEY) {
    emit({ type: "error", message: "OPENROUTER_API_KEY is not configured.", code: "OPENROUTER_NOT_CONFIGURED" });
    return;
  }
  if (catalog.models.length === 0) {
    emit({
      type: "error",
      message:
        catalog.error ??
        "No free, tool-capable model with enough context is available on OpenRouter right now. KI00 will not switch to a paid model.",
      code: "NO_FREE_MODEL",
    });
    return;
  }

  const requested = input.model?.trim();
  if (requested && !catalog.models.some((model) => model.id === requested)) {
    emit({
      type: "error",
      message: "The requested model is not in the current free, tool-capable model catalog.",
      code: "MODEL_NOT_ALLOWED",
    });
    return;
  }
  let model = requested ?? catalog.selectedModel ?? catalog.models[0]!.id;
  const attempted = [model];

  const thread = await resolveThread(env, actor, input);
  if (!thread) {
    emit({ type: "error", message: "Conversation not found in this workspace." });
    return;
  }

  const userMessageId = newId("msg");
  await dbRun(
    env.DB,
    `INSERT INTO agent_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
    userMessageId,
    thread.id,
    input.message,
    now()
  );
  if (thread.title === "New conversation") {
    await dbRun(
      env.DB,
      "UPDATE agent_threads SET title = ?, updated_at = ? WHERE id = ?",
      truncate(input.message.replace(/\s+/g, " "), 70),
      now(),
      thread.id
    );
  }

  const runId = newId("run");
  await dbRun(
    env.DB,
    `INSERT INTO agent_runs (id, thread_id, status, model, started_at) VALUES (?, ?, 'running', ?, ?)`,
    runId,
    thread.id,
    model,
    now()
  );
  emit({
    type: "run_start",
    runId,
    threadId: String(thread.id),
    model,
    modelName: catalog.models.find((item) => item.id === model)?.name ?? model,
  });

  const project = input.projectId ? await loadProject(env, actor.workspaceId, input.projectId) : null;
  const ctx: ToolContext = {
    env,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    projectId: input.projectId ?? null,
  };

  const conversation = await buildConversation(env, thread.id as string);
  conversation.unshift({ role: "system", content: systemPrompt(project, catalog.models) });

  let calls = 0;
  let toolCallsUsed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let status = "completed";
  let errorMessage: string | null = null;

  while (calls < MAX_MODEL_CALLS) {
    calls++;
    emit({ type: "model_call", call: calls, model });
    const client = OpenRouterClient.fromEnv(env);
    let completion;
    try {
      completion = await client.chat({
        model,
        messages: conversation as ChatMessage[],
        tools: AGENT_TOOLS,
        maxTokens: 4096,
        temperature: 0.2,
      });
    } catch (error) {
      const retryable =
        error instanceof Error &&
        "code" in error &&
        ["OPENROUTER_RETRYABLE", "OPENROUTER_MODEL_UNAVAILABLE"].includes(
          String((error as { code?: string }).code)
        );
      const fallback = retryable ? fallbackModels(catalog.models, model, attempted)[0] : undefined;
      if (fallback && calls < MAX_MODEL_CALLS) {
        attempted.push(fallback.id);
        emit({
          type: "model_switch",
          from: model,
          to: fallback.id,
          reason: error instanceof Error ? error.message : "Temporary provider error",
        });
        model = fallback.id;
        continue;
      }
      status = "failed";
      errorMessage = error instanceof Error ? error.message : "The free model call failed";
      emit({ type: "error", message: errorMessage });
      break;
    }

    promptTokens += completion.promptTokens;
    completionTokens += completion.completionTokens;
    emit({ type: "usage", calls, promptTokens, completionTokens, maxCalls: MAX_MODEL_CALLS });

    const content = completion.content.trim();
    const toolCalls = completion.toolCalls.slice(0, MAX_TOOLS_PER_TURN);
    const assistantRowId = newId("msg");
    await dbRun(
      env.DB,
      `INSERT INTO agent_messages (id, thread_id, role, content, tool_args_json, model, prompt_tokens, completion_tokens, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`,
      assistantRowId,
      thread.id,
      content,
      toolCalls.length ? JSON.stringify(toolCalls) : null,
      completion.model,
      completion.promptTokens,
      completion.completionTokens,
      now()
    );
    if (content) emit({ type: "message", content });

    if (toolCalls.length === 0) {
      if (!content) {
        status = "failed";
        errorMessage = "The model returned an empty response. Try another free model.";
        emit({ type: "error", message: errorMessage });
      }
      break;
    }

    conversation.push({
      role: "assistant",
      content,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (toolCallsUsed >= MAX_TOOL_CALLS) {
        const limitResult = { error: "Tool-call limit for this run reached. Finish with the information you have." };
        await storeToolMessage(env, thread.id as string, call, {}, limitResult, "limit");
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(limitResult),
        });
        continue;
      }
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch {
        const invalid = { error: "Tool arguments were not valid JSON. Retry with valid JSON." };
        await storeToolMessage(env, thread.id as string, call, {}, invalid, "invalid_args");
        conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(invalid) });
        emit({ type: "tool_result", name: call.function.name, ok: false, summary: "Invalid arguments", result: invalid });
        continue;
      }

      emit({ type: "tool_start", name: call.function.name, args: parsedArgs });
      if (PRIVILEGED_TOOLS.has(call.function.name)) {
        const preview = approvalPreview(call.function.name, parsedArgs);
        let resolvedProjectId = preview.projectId;
        if (!resolvedProjectId) {
          try {
            const { resolveProject } = await import("./agent-tools");
            const projectRow = await resolveProject(ctx, undefined);
            resolvedProjectId = String(projectRow.id);
          } catch {
            resolvedProjectId = null;
          }
        }
        const approvalId = newId("apv");
        await dbRun(
          env.DB,
          `INSERT INTO approvals (id, workspace_id, thread_id, project_id, action, args_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
          approvalId,
          actor.workspaceId,
          thread.id,
          resolvedProjectId,
          call.function.name,
          JSON.stringify(parsedArgs),
          now()
        );
        const result = {
          status: "approval_required",
          approvalId,
          message:
            "This action needs explicit approval in the KI00 UI. Tell the user what it will do and that it has not happened yet.",
        };
        await storeToolMessage(env, thread.id as string, call, parsedArgs, result, "approval");
        conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        emit({
          type: "approval",
          approvalId,
          action: call.function.name,
          args: parsedArgs,
        });
        emit({
          type: "tool_result",
          name: call.function.name,
          ok: false,
          summary: "Waiting for user approval",
          result,
        });
        toolCallsUsed++;
        continue;
      }

      const result = await executeReadTool(ctx, call.function.name, parsedArgs);
      toolCallsUsed++;
      await storeToolMessage(env, thread.id as string, call, parsedArgs, result.result, result.ok ? "ok" : "error");
      conversation.push({
        role: "tool",
        tool_call_id: call.id,
        content: truncate(JSON.stringify(result.result), 6000),
      });
      emit({
        type: "tool_result",
        name: call.function.name,
        ok: result.ok,
        summary: result.summary,
        result: result.result,
      });
    }

    if (calls >= MAX_MODEL_CALLS) {
      const note =
        "KI00 stopped this run after the maximum of 8 model calls. The conversation state is saved; send a follow-up to continue deliberately.";
      await dbRun(
        env.DB,
        `INSERT INTO agent_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'system', ?, ?)`,
        newId("msg"),
        thread.id,
        note,
        now()
      );
      emit({ type: "limit", message: note });
      status = "stopped";
      break;
    }
  }

  const finished = now();
  await dbRun(
    env.DB,
    `UPDATE agent_runs SET status = ?, model = ?, calls = ?, tool_calls = ?, prompt_tokens = ?, completion_tokens = ?, error = ?, finished_at = ?
     WHERE id = ?`,
    status === "completed" ? "completed" : status === "stopped" ? "stopped" : "failed",
    model,
    calls,
    toolCallsUsed,
    promptTokens,
    completionTokens,
    errorMessage,
    finished,
    runId
  );
  await dbRun(env.DB, "UPDATE agent_threads SET model = ?, updated_at = ? WHERE id = ?", model, finished, thread.id);
  emit({ type: "usage", calls, promptTokens, completionTokens, maxCalls: MAX_MODEL_CALLS });
  emit({ type: "done", runId, status });
}

async function resolveThread(
  env: Env,
  actor: AgentActor,
  input: AgentRunInput
): Promise<Record<string, any> | null> {
  if (input.threadId) {
    const existing = await dbFirst<Record<string, any>>(
      env.DB,
      "SELECT * FROM agent_threads WHERE id = ? AND workspace_id = ?",
      input.threadId,
      actor.workspaceId
    );
    return existing ?? null;
  }
  const id = newId("thr");
  const ts = now();
  await dbRun(
    env.DB,
    `INSERT INTO agent_threads (id, workspace_id, project_id, title, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'New conversation', ?, ?, ?)`,
    id,
    actor.workspaceId,
    input.projectId ?? null,
    actor.userId,
    ts,
    ts
  );
  return dbFirst<Record<string, any>>(env.DB, "SELECT * FROM agent_threads WHERE id = ?", id);
}

async function buildConversation(
  env: Env,
  threadId: string
): Promise<ConversationEntry[]> {
  const rows = await dbAll<Record<string, any>>(
    env.DB,
    "SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
    threadId
  );
  const selected = rows.filter((row) => ["user", "assistant", "tool"].includes(row.role)).slice(-18);
  const entries: ConversationEntry[] = [];
  for (const row of selected) {
    if (row.role === "assistant") {
      let toolCalls: ToolCall[] | undefined;
      if (row.tool_args_json) {
        try {
          const parsed = JSON.parse(row.tool_args_json);
          if (Array.isArray(parsed)) toolCalls = parsed as ToolCall[];
        } catch {
          toolCalls = undefined;
        }
      }
      entries.push({ role: "assistant", content: String(row.content ?? ""), ...(toolCalls?.length ? { tool_calls: toolCalls } : {}) });
    } else if (row.role === "tool") {
      entries.push({
        role: "tool",
        tool_call_id: String(row.tool_call_id ?? ""),
        content: truncate(String(row.tool_result_json ?? "{}"), 6000),
      });
    } else {
      entries.push({ role: "user", content: String(row.content ?? "") });
    }
  }
  return entries;
}

function systemPrompt(project: Record<string, any> | null, models: FreeModel[]): string {
  const selected = models[0];
  return `You are the KI00 agent, an engineering assistant embedded in a Cloudflare-native deployment platform.
KI00 deploys compatible projects to Cloudflare Workers using Workers Builds. It does not use Railway or Docker on the free plan.

Hard rules:
- Use the provided tools to inspect real data. Never invent logs, commits, deployment statuses, URLs or build results.
- Never claim an action succeeded based on intention. A deployment is only successful when a tool reports Cloudflare's build outcome as success.
- Never switch to a paid model; KI00 only gives you free models. The current free catalog has ${models.length} eligible model(s); the top-ranked is ${selected?.id ?? "unknown"}.
- Never reveal, print or request secrets, tokens, environment variable VALUES, or .env file contents. Variable names are fine.
- Deleting resources, writing to GitHub, starting deployments and preview builds require explicit user approval in the KI00 UI. Use the approval tools; they do not execute immediately.
- Do not send the whole repository to yourself. List files and read only relevant ones.
- Cloudflare Workers cannot run Docker images, arbitrary Linux processes, long-lived processes, or arbitrary ports on the free plan. If compatibility is uncertain, say so and use analyze_repository.
- When a project is incompatible, explain the blocker and concrete migration options. Never suggest that a container is free.
- Keep answers concise, technical and specific. Show file paths, commands, commit SHAs and real status values.

${
  project
    ? `Selected project:
- id: ${project.id}
- name: ${project.name}
- repo: ${project.repo_owner}/${project.repo_name}
- branch: ${project.branch}
- runtime: ${project.runtime_kind} (${project.runtime_detail ?? "unset"})
- framework: ${project.framework ?? "unknown"}
- compatibility: ${project.compatibility_status}
- build: ${project.build_command || "(none)"}
- output: ${project.output_dir}
- worker: ${project.worker_name}
- URL: ${project.custom_url ?? project.workers_dev_url ?? "no URL yet"}
- last build: ${project.last_build_status ?? "none"}`
    : "No project is selected. Ask the user to select one before project-specific work."
}`;
}

async function loadProject(
  env: Env,
  workspaceId: string,
  projectId: string
): Promise<Record<string, any> | null> {
  return dbFirst<Record<string, any>>(
    env.DB,
    "SELECT * FROM projects WHERE id = ? AND workspace_id = ?",
    projectId,
    workspaceId
  );
}

async function storeToolMessage(
  env: Env,
  threadId: string,
  call: ToolCall,
  args: Record<string, unknown>,
  result: unknown,
  state: string
): Promise<void> {
  const payload = {
    ...(typeof result === "object" && result !== null ? result : { result }),
    __state: state,
  };
  await dbRun(
    env.DB,
    `INSERT INTO agent_messages (id, thread_id, role, content, tool_name, tool_call_id, tool_args_json, tool_result_json, created_at)
     VALUES (?, ?, 'tool', ?, ?, ?, ?, ?, ?)`,
    newId("msg"),
    threadId,
    truncate(JSON.stringify(payload), 4000),
    call.function.name,
    call.id,
    JSON.stringify(args),
    truncate(JSON.stringify(payload), 20_000),
    now()
  );
}
