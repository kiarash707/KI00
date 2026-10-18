import { z } from "zod";
import type { Env } from "../env";
import type { ToolDefinition } from "./openrouter";
import { dbAll, dbFirst } from "./db";
import { mapDeployment, mapProject } from "./mappers";
import { GitHubClient } from "./github";
import { analyzeRepository } from "./analysis";
import { fetchDeploymentLogs, startDeployment, clientForWorkspace } from "./deploy-engine";
import { isSafeRepoPath } from "./github";
import { isDemo } from "./providers";
import { redactSecrets, truncate } from "./utils";

export interface ToolContext {
  env: Env;
  workspaceId: string;
  userId: string;
  projectId: string | null;
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_project_context",
      description:
        "Return KI00 project configuration, compatibility, variable NAMES (never values), domains, and recent deployments for one project.",
      parameters: {
        type: "object",
        properties: { project_id: { type: "string", description: "KI00 project id (optional if a project is selected)" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_repository_files",
      description:
        "List files in the project's GitHub repository for a branch. Use this instead of asking for the whole repository. Returns at most 200 paths.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path_prefix: { type: "string", description: "Optional path prefix such as src/ or apps/web/" },
          branch: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_repository_file",
      description:
        "Read one text file from the repository (max 40 KB). Sensitive files such as .env, keys and credentials are refused.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path: { type: "string" },
          branch: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_repository",
      description:
        "Run KI00's repository detection and Workers compatibility analysis. Returns framework, runtime, build settings, blockers and migration options.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          branch: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_deployments",
      description: "List recent real KI00 deployments for a project or the workspace, with status and commit.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          limit: { type: "number", description: "1-20, default 8" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_build_logs",
      description:
        "Fetch the real Cloudflare Workers Builds log for a deployment. Logs are never synthesised. Large logs are truncated.",
      parameters: {
        type: "object",
        properties: {
          deployment_id: { type: "string" },
          max_lines: { type: "number", description: "Default 120, maximum 300" },
        },
        required: ["deployment_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_runtime_logs",
      description:
        "Query Cloudflare Workers Observability for recent runtime logs of a deployed Worker. Returns an explicit error if the token cannot read telemetry.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          minutes: { type: "number", description: "Look-back window in minutes (5-1440, default 60)" },
          level: { type: "string", enum: ["all", "info", "warn", "error", "debug"] },
          search: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cloudflare_resources",
      description:
        "Return real Cloudflare account status relevant to KI00: account, workers.dev subdomain, Worker count and build-minute availability.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "create_patch_branch",
      description:
        "REQUIRES USER APPROVAL. Create a new GitHub branch with up to 8 file patches. The human must approve it in KI00 before anything is written to GitHub.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          branch_name: { type: "string", description: "New branch, e.g. ki00/fix-wrangler-config" },
          base_branch: { type: "string" },
          message: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
        },
        required: ["branch_name", "message", "files"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trigger_deployment",
      description:
        "REQUIRES USER APPROVAL. Start a real production deployment on Cloudflare Workers Builds. Never claim it succeeded; later poll with list_deployments or inspect logs.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          branch: { type: "string" },
          commit_sha: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_preview_build",
      description:
        "REQUIRES USER APPROVAL. Start a preview build on Cloudflare Workers Builds for a non-production branch.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          branch: { type: "string" },
        },
        required: ["branch"],
        additionalProperties: false,
      },
    },
  },
];

export const PRIVILEGED_TOOLS = new Set([
  "create_patch_branch",
  "trigger_deployment",
  "create_preview_build",
]);

const patchSchema = z.object({
  project_id: z.string().optional(),
  branch_name: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[A-Za-z0-9._/-]+$/, "Invalid branch name"),
  base_branch: z.string().max(120).optional(),
  message: z.string().min(3).max(400),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        content: z.string().max(120_000),
      })
    )
    .min(1)
    .max(8),
});

const deploySchema = z.object({
  project_id: z.string().optional(),
  branch: z.string().max(120).regex(/^[A-Za-z0-9._/-]+$/).optional(),
  commit_sha: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
});

const previewSchema = z.object({
  project_id: z.string().optional(),
  branch: z.string().min(1).max(120).regex(/^[A-Za-z0-9._/-]+$/),
});

export async function resolveProject(
  ctx: ToolContext,
  requested?: string
): Promise<Record<string, any>> {
  const id = requested || ctx.projectId;
  if (!id) {
    throw new Error("No project is selected. Pass project_id (call get_project_context only when a project exists).");
  }
  const project = await dbFirst<Record<string, any>>(
    ctx.env.DB,
    "SELECT * FROM projects WHERE id = ? AND workspace_id = ?",
    id,
    ctx.workspaceId
  );
  if (!project) throw new Error("Project not found in this workspace");
  return project;
}

export async function executeReadTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown
): Promise<{ ok: boolean; result: unknown; summary: string }> {
  const args = (rawArgs ?? {}) as Record<string, any>;
  try {
    switch (name) {
      case "get_project_context": {
        const project = await resolveProject(ctx, args.project_id);
        const [envRows, deployments, domains] = await Promise.all([
          dbAll<{ key: string; scope: string; use_build: number; use_runtime: number }>(
            ctx.env.DB,
            "SELECT key, scope, use_build, use_runtime FROM env_vars WHERE project_id = ? ORDER BY key",
            project.id
          ),
          dbAll<Record<string, any>>(
            ctx.env.DB,
            "SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT 5",
            project.id
          ),
          dbAll<Record<string, any>>(
            ctx.env.DB,
            "SELECT hostname, status FROM domains WHERE project_id = ?",
            project.id
          ),
        ]);
        const result = {
          project: mapProject(project),
          variables: envRows.map((row) => ({
            key: row.key,
            scope: row.scope,
            build: Boolean(row.use_build),
            runtime: Boolean(row.use_runtime),
          })),
          deployments: deployments.map((row) => mapDeployment(row)),
          domains: domains.map((row) => ({ hostname: row.hostname, status: row.status })),
        };
        return { ok: true, result, summary: `Project ${project.name}: ${project.runtime_kind}, ${project.compatibility_status}` };
      }
      case "list_repository_files": {
        const project = await resolveProject(ctx, args.project_id);
        const github = GitHubClient.fromEnv(ctx.env);
        const branch = typeof args.branch === "string" ? args.branch : String(project.branch);
        const tree = await github.getTree(project.repo_owner, project.repo_name, branch);
        const prefix = typeof args.path_prefix === "string" ? args.path_prefix.slice(0, 120) : "";
        const files = tree.entries
          .filter((entry) => entry.type === "blob" && (!prefix || entry.path.startsWith(prefix)))
          .slice(0, 200)
          .map((entry) => entry.path);
        return {
          ok: true,
          result: { branch, files, truncated: tree.truncated || tree.entries.length > 200, totalFiles: tree.entries.length },
          summary: `${files.length} file paths from ${branch}`,
        };
      }
      case "read_repository_file": {
        const project = await resolveProject(ctx, args.project_id);
        const path = String(args.path ?? "");
        if (!isSafeRepoPath(path) || isSensitivePath(path)) {
          return {
            ok: false,
            result: { error: "Refused to read this path. Secrets and unsafe paths are blocked." },
            summary: "Refused sensitive path",
          };
        }
        const github = GitHubClient.fromEnv(ctx.env);
        const branch = typeof args.branch === "string" ? args.branch : String(project.branch);
        const file = await github.getFile(project.repo_owner, project.repo_name, path, branch);
        if (!file) return { ok: false, result: { error: "File not found" }, summary: "File not found" };
        const content = redactSecrets(file.content, toolSecrets(ctx.env));
        return {
          ok: true,
          result: {
            path,
            branch,
            size: file.size,
            truncated: file.truncated || content.length > 40_000,
            content: truncate(content, 40_000),
          },
          summary: `Read ${path} (${file.size} bytes)`,
        };
      }
      case "analyze_repository": {
        const project = await resolveProject(ctx, args.project_id);
        const github = GitHubClient.fromEnv(ctx.env);
        const analysis = await analyzeRepository(
          github,
          project.repo_owner,
          project.repo_name,
          typeof args.branch === "string" ? args.branch : String(project.branch)
        );
        const result = {
          branch: analysis.branch,
          commit: analysis.commit,
          fileCount: analysis.fileCount,
          detection: analysis.detection,
          warnings: analysis.warnings,
        };
        return {
          ok: true,
          result,
          summary: `${analysis.detection.framework} · ${analysis.detection.runtimeKind} · ${analysis.detection.compatibilityStatus}`,
        };
      }
      case "list_deployments": {
        const project = args.project_id ? await resolveProject(ctx, args.project_id) : null;
        const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8)));
        const rows = await dbAll<Record<string, any>>(
          ctx.env.DB,
          project
            ? "SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
            : "SELECT * FROM deployments WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
          project ? project.id : ctx.workspaceId,
          limit
        );
        return {
          ok: true,
          result: rows.map((row) => mapDeployment(row)),
          summary: `${rows.length} deployment records`,
        };
      }
      case "get_build_logs": {
        const deploymentId = String(args.deployment_id ?? "");
        if (!deploymentId) return { ok: false, result: { error: "deployment_id is required" }, summary: "Missing id" };
        const logs = await fetchDeploymentLogs(ctx.env, deploymentId, ctx.workspaceId);
        const maxLines = Math.min(300, Math.max(20, Number(args.max_lines ?? 120)));
        const lines = logs.lines.slice(-maxLines);
        const text = lines.map((line) => `${line.level.toUpperCase()} ${line.text}`).join("\n");
        return {
          ok: true,
          result: {
            deploymentId,
            status: logs.deployment.status,
            source: logs.source,
            error: logs.error,
            truncated: logs.truncated || logs.lines.length > maxLines,
            logCount: logs.lines.length,
            logs: truncate(redactSecrets(text, toolSecrets(ctx.env)), 30_000),
          },
          summary: `${lines.length} log lines (${logs.source})`,
        };
      }
      case "get_runtime_logs": {
        const project = await resolveProject(ctx, args.project_id);
        if (project.runtime_kind !== "worker") {
          return {
            ok: false,
            result: { error: "This project is a static site and has no Worker runtime logs." },
            summary: "No runtime",
          };
        }
        const { client } = await clientForWorkspace(ctx.env, ctx.workspaceId);
        const minutes = Math.min(1440, Math.max(5, Number(args.minutes ?? 60)));
        const nowMs = Date.now();
        const result = await client.queryRuntimeLogs({
          scriptName: String(project.worker_name),
          from: nowMs - minutes * 60_000,
          to: nowMs,
          limit: 120,
          level: typeof args.level === "string" ? args.level : "all",
          text: typeof args.search === "string" ? args.search : undefined,
        });
        return {
          ok: result.available,
          result: {
            available: result.available,
            error: result.error,
            lines: result.lines.slice(0, 120).map((line) => ({ ...line, text: truncate(redactSecrets(line.text, toolSecrets(ctx.env)), 1500) })),
          },
          summary: result.available ? `${result.lines.length} runtime events` : "Runtime logs unavailable",
        };
      }
      case "get_cloudflare_resources": {
        if (isDemo(ctx.env)) {
          return { ok: true, result: { demo: true, error: "Demo mode does not call Cloudflare" }, summary: "Demo mode" };
        }
        const { client, accountId } = await clientForWorkspace(ctx.env, ctx.workspaceId);
        const [limits, scripts, subdomain] = await Promise.allSettled([
          client.getBuildLimits(),
          client.listWorkers(),
          client.getWorkersSubdomain(),
        ]);
        return {
          ok: true,
          result: {
            accountId,
            buildMinutes: limits.status === "fulfilled" ? limits.value : { error: "unavailable" },
            workerCount: scripts.status === "fulfilled" ? scripts.value.length : null,
            workersSubdomain: subdomain.status === "fulfilled" ? subdomain.value : null,
          },
          summary: "Cloudflare account status retrieved",
        };
      }
      default:
        return { ok: false, result: { error: `Unknown tool: ${name}` }, summary: "Unknown tool" };
    }
  } catch (error) {
    return {
      ok: false,
      result: { error: error instanceof Error ? error.message : "Tool failed" },
      summary: "Tool failed",
    };
  }
}

export function approvalPreview(
  name: string,
  args: Record<string, unknown>
): { action: string; projectId: string | null; summary: string } {
  if (name === "create_patch_branch") {
    const files = Array.isArray(args.files) ? args.files : [];
    return {
      action: name,
      projectId: typeof args.project_id === "string" ? args.project_id : null,
      summary: `Create branch ${String(args.branch_name ?? "")} with ${files.length} changed file(s): ${files
        .map((file) => String((file as { path?: string }).path ?? "?"))
        .join(", ")}`,
    };
  }
  if (name === "trigger_deployment") {
    return {
      action: name,
      projectId: typeof args.project_id === "string" ? args.project_id : null,
      summary: `Start a production deployment${args.branch ? ` from ${String(args.branch)}` : ""}${args.commit_sha ? ` at commit ${String(args.commit_sha).slice(0, 7)}` : ""}`,
    };
  }
  return {
    action: name,
    projectId: typeof args.project_id === "string" ? args.project_id : null,
    summary: `Start a preview build for branch ${String(args.branch ?? "")}`,
  };
}

export async function executeApprovedAction(
  ctx: ToolContext,
  action: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; result: unknown; summary: string }> {
  try {
    if (action === "create_patch_branch") {
      const parsed = patchSchema.safeParse(args);
      if (!parsed.success) return { ok: false, result: { error: parsed.error.issues[0]?.message }, summary: "Invalid arguments" };
      const project = await resolveProject(ctx, parsed.data.project_id);
      const files = parsed.data.files.filter((file) => isSafeRepoPath(file.path) && !isSensitivePath(file.path));
      if (files.length !== parsed.data.files.length) {
        return { ok: false, result: { error: "A patch touched a blocked or unsafe path" }, summary: "Unsafe path" };
      }
      const github = GitHubClient.fromEnv(ctx.env);
      const result = await github.createPatchBranch({
        owner: String(project.repo_owner),
        repo: String(project.repo_name),
        baseBranch: parsed.data.base_branch ?? String(project.branch),
        newBranch: parsed.data.branch_name,
        files,
        message: parsed.data.message,
      });
      return {
        ok: true,
        result,
        summary: `Branch ${result.branch} created at ${result.commitSha.slice(0, 7)}`,
      };
    }
    if (action === "trigger_deployment") {
      const parsed = deploySchema.safeParse(args);
      if (!parsed.success) return { ok: false, result: { error: parsed.error.issues[0]?.message }, summary: "Invalid arguments" };
      const project = await resolveProject(ctx, parsed.data.project_id);
      if (isDemo(ctx.env)) return { ok: false, result: { error: "Demo mode" }, summary: "Demo mode" };
      const deploymentId = await startDeployment(ctx.env, project, {
        branch: parsed.data.branch,
        commitSha: parsed.data.commit_sha,
        triggerKind: "production",
        acknowledgeRepoConfig: true,
        requestedBy: ctx.userId,
      });
      return {
        ok: true,
        result: { deploymentId, status: "queued", note: "The build is queued. It is not successful until Cloudflare reports success." },
        summary: `Deployment ${deploymentId} queued`,
      };
    }
    if (action === "create_preview_build") {
      const parsed = previewSchema.safeParse(args);
      if (!parsed.success) return { ok: false, result: { error: parsed.error.issues[0]?.message }, summary: "Invalid arguments" };
      const project = await resolveProject(ctx, parsed.data.project_id);
      if (isDemo(ctx.env)) return { ok: false, result: { error: "Demo mode" }, summary: "Demo mode" };
      const deploymentId = await startDeployment(ctx.env, project, {
        branch: parsed.data.branch,
        triggerKind: "preview",
        acknowledgeRepoConfig: true,
        requestedBy: ctx.userId,
      });
      return {
        ok: true,
        result: { deploymentId, status: "queued", note: "Preview build queued; preview URLs appear after Cloudflare finishes." },
        summary: `Preview build ${deploymentId} queued`,
      };
    }
    return { ok: false, result: { error: "Unsupported approval action" }, summary: "Unsupported" };
  } catch (error) {
    return {
      ok: false,
      result: { error: error instanceof Error ? error.message : "Approved action failed" },
      summary: "Action failed",
    };
  }
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base.startsWith(".env")) return true;
  if (base === ".npmrc" || base === ".netrc" || base === "id_rsa" || base === "id_ed25519") return true;
  if (/\.(pem|key|p12|pfx|keystore)$/.test(base)) return true;
  if (/(secret|credential|private[-_]?key)/.test(base)) return true;
  return false;
}

function toolSecrets(env: Env): string[] {
  return [env.CLOUDFLARE_API_TOKEN, env.GITHUB_TOKEN, env.OPENROUTER_API_KEY, env.KI00_ENCRYPTION_KEY].filter(
    (value): value is string => Boolean(value && value.length >= 6)
  );
}
