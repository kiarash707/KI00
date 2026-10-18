import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { AgentMessage, AgentThread, Approval } from "../../shared/types";
import { requireAuth } from "../lib/auth";
import { ApiError, formatZodError } from "../lib/errors";
import { dbAll, dbFirst, dbRun } from "../lib/db";
import { agentRunSchema, approvalResolveSchema } from "../lib/validation";
import { enforceRateLimit, workspaceLimitKey } from "./helpers";
import { getModelCatalog } from "../lib/models";
import { isDemo } from "../lib/providers";
import { runAgent } from "../lib/agent";
import { executeApprovedAction, type ToolContext } from "../lib/agent-tools";
import { newId, now } from "../lib/utils";
import { recordAudit } from "../lib/activity";

export const agentRoutes = new Hono<AppEnv>();

agentRoutes.get("/models", async (c) => {
  requireAuth(c);
  if (!c.env.OPENROUTER_API_KEY && !isDemo(c.env)) {
    return c.json({
      models: [],
      selectedModel: null,
      selectedModelName: null,
      selectionReason: null,
      fetchedAt: null,
      stale: true,
      error: "OPENROUTER_API_KEY is not configured. The AI agent is disabled.",
      overridden: false,
    });
  }
  if (isDemo(c.env)) {
    return c.json({
      models: [],
      selectedModel: null,
      selectedModelName: null,
      selectionReason: "Demo mode: OpenRouter is not queried.",
      fetchedAt: null,
      stale: true,
      error: "Demo mode does not call OpenRouter.",
      overridden: false,
    });
  }
  const catalog = await getModelCatalog(c.env);
  return c.json(catalog);
});

agentRoutes.post("/models/refresh", async (c) => {
  const { workspace } = requireAuth(c);
  if (!c.env.OPENROUTER_API_KEY) {
    throw new ApiError(424, "OPENROUTER_NOT_CONFIGURED", "OPENROUTER_API_KEY is not configured");
  }
  await enforceRateLimit(c, workspaceLimitKey(c, "models:refresh"), 6, 60 * 60 * 1000);
  const catalog = await getModelCatalog(c.env, { refresh: true });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "models.refresh",
    targetType: "openrouter",
    targetId: "catalog",
    meta: { modelCount: catalog.models.length },
  });
  return c.json(catalog);
});

agentRoutes.get("/agent/threads", async (c) => {
  const { workspace } = requireAuth(c);
  const rows = await dbAll<Record<string, any>>(
    c.env.DB,
    `SELECT t.*, p.name AS project_name,
      (SELECT COUNT(*) FROM agent_messages m WHERE m.thread_id = t.id) AS message_count
     FROM agent_threads t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.workspace_id = ? ORDER BY t.updated_at DESC LIMIT 50`,
    workspace.id
  );
  const items: AgentThread[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count ?? 0),
  }));
  return c.json({ items });
});

agentRoutes.get("/agent/threads/:id", async (c) => {
  const { workspace } = requireAuth(c);
  const thread = await dbFirst<Record<string, any>>(
    c.env.DB,
    `SELECT t.*, p.name AS project_name FROM agent_threads t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.id = ? AND t.workspace_id = ?`,
    c.req.param("id"),
    workspace.id
  );
  if (!thread) throw new ApiError(404, "THREAD_NOT_FOUND", "Conversation not found");
  const [messages, approvals] = await Promise.all([
    dbAll<Record<string, any>>(
      c.env.DB,
      "SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
      thread.id
    ),
    dbAll<Record<string, any>>(
      c.env.DB,
      "SELECT * FROM approvals WHERE thread_id = ? ORDER BY created_at DESC",
      thread.id
    ),
  ]);
  return c.json({
    thread: {
      id: thread.id,
      title: thread.title,
      projectId: thread.project_id,
      projectName: thread.project_name,
      model: thread.model,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
    } satisfies AgentThread,
    messages: messages.map(mapAgentMessage),
    approvals: approvals.map(mapApproval),
  });
});

agentRoutes.delete("/agent/threads/:id", async (c) => {
  const { workspace } = requireAuth(c);
  const thread = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM agent_threads WHERE id = ? AND workspace_id = ?",
    c.req.param("id"),
    workspace.id
  );
  if (!thread) throw new ApiError(404, "THREAD_NOT_FOUND", "Conversation not found");
  await dbRun(c.env.DB, "DELETE FROM approvals WHERE thread_id = ?", thread.id);
  await dbRun(c.env.DB, "DELETE FROM agent_messages WHERE thread_id = ?", thread.id);
  await dbRun(c.env.DB, "DELETE FROM agent_threads WHERE id = ?", thread.id);
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "agent.thread.delete",
    targetType: "agent_thread",
    targetId: thread.id,
  });
  return c.json({ ok: true });
});

agentRoutes.post("/agent/run", async (c) => {
  const { workspace, user } = requireAuth(c);
  if (isDemo(c.env)) {
    throw new ApiError(409, "DEMO_READ_ONLY", "The AI agent is disabled in the demo workspace", {
      hint: "Configure OPENROUTER_API_KEY and connect Cloudflare/GitHub to run the real agent.",
    });
  }
  if (!c.env.OPENROUTER_API_KEY) {
    throw new ApiError(424, "OPENROUTER_NOT_CONFIGURED", "OPENROUTER_API_KEY is not configured", {
      hint: "Set the OPENROUTER_API_KEY Worker secret. It is never sent to the browser.",
    });
  }
  const parsed = agentRunSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  await enforceRateLimit(c, workspaceLimitKey(c, "agent:run"), 10, 60 * 60 * 1000);
  if (parsed.data.projectId) {
    const project = await dbFirst<{ id: string }>(
      c.env.DB,
      "SELECT id FROM projects WHERE id = ? AND workspace_id = ?",
      parsed.data.projectId,
      workspace.id
    );
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      runAgent(
        c.env,
        { workspaceId: workspace.id, userId: user.id, userEmail: user.email },
        {
          threadId: parsed.data.threadId,
          projectId: parsed.data.projectId ?? null,
          message: parsed.data.message,
          model: parsed.data.model,
        },
        send
      )
        .catch((error) => {
          send({
            type: "error",
            message: error instanceof Error ? error.message : "Agent run failed",
          });
          send({ type: "done", runId: "unknown", status: "failed" });
        })
        .finally(() => {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "x-accel-buffering": "no",
    },
  });
});

agentRoutes.post("/agent/approvals/:id", async (c) => {
  const { workspace, user } = requireAuth(c);
  const approval = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM approvals WHERE id = ? AND workspace_id = ?",
    c.req.param("id"),
    workspace.id
  );
  if (!approval) throw new ApiError(404, "APPROVAL_NOT_FOUND", "Approval request not found");
  if (approval.status !== "pending") {
    throw new ApiError(409, "APPROVAL_RESOLVED", "This approval has already been resolved");
  }
  const parsed = approvalResolveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  await enforceRateLimit(c, workspaceLimitKey(c, "agent:approvals"), 30, 60 * 60 * 1000);
  const ts = now();
  let result: { ok: boolean; result: unknown; summary: string };

  if (parsed.data.decision === "reject") {
    await dbRun(
      c.env.DB,
      "UPDATE approvals SET status = 'rejected', resolved_at = ? WHERE id = ?",
      ts,
      approval.id
    );
    result = { ok: false, result: { status: "rejected" }, summary: "Rejected by user" };
  } else {
    const args = JSON.parse(approval.args_json) as Record<string, unknown>;
    const ctx: ToolContext = {
      env: c.env,
      workspaceId: workspace.id,
      userId: user.id,
      projectId: approval.project_id ?? null,
    };
    result = await executeApprovedAction(ctx, String(approval.action), args);
    await dbRun(
      c.env.DB,
      "UPDATE approvals SET status = 'approved', resolved_at = ? WHERE id = ?",
      ts,
      approval.id
    );
    await recordAudit(c, {
      workspaceId: workspace.id,
      action: `agent.approval.${approval.action}`,
      targetType: "approval",
      targetId: approval.id,
      meta: { ok: result.ok, projectId: approval.project_id, summary: result.summary },
    });
  }

  if (approval.thread_id) {
    await dbRun(
      c.env.DB,
      `INSERT INTO agent_messages (id, thread_id, role, content, tool_name, tool_args_json, tool_result_json, created_at)
       VALUES (?, ?, 'approval', ?, ?, ?, ?, ?)`,
      newId("msg"),
      approval.thread_id,
      `${parsed.data.decision === "approve" ? "Approved" : "Rejected"}: ${result.summary}`,
      approval.action,
      approval.args_json,
      JSON.stringify({ ...result, decision: parsed.data.decision }),
      ts
    );
  }

  return c.json({
    approval: { ...mapApproval({ ...approval, status: parsed.data.decision === "approve" ? "approved" : "rejected", resolved_at: ts }) },
    result,
  });
});

function mapAgentMessage(row: Record<string, any>): AgentMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content ?? "",
    toolName: row.tool_name ?? null,
    toolArgs: safeJson(row.tool_args_json),
    toolResult: safeJson(row.tool_result_json),
    model: row.model ?? null,
    createdAt: row.created_at,
  };
}

function mapApproval(row: Record<string, any>): Approval {
  return {
    id: row.id,
    action: row.action,
    args: safeJson(row.args_json) as Record<string, unknown> ?? {},
    status: row.status,
    projectId: row.project_id ?? null,
    threadId: row.thread_id ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

function safeJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
