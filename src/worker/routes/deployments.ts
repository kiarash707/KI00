import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { DeploymentDetail, DeploymentWithProject, RuntimeLogsResponse } from "../../shared/types";
import { requireAuth } from "../lib/auth";
import { ApiError, notConfigured } from "../lib/errors";
import { dbAll, dbFirst } from "../lib/db";
import { mapActivity, mapDeployment, mapProject } from "../lib/mappers";
import { fetchDeploymentLogs, cancelDeployment, syncDeployment, clientForWorkspace } from "../lib/deploy-engine";
import { enforceRateLimit, loadProjectOr404, parsePagination } from "./helpers";
import { recordAudit } from "../lib/activity";
import { isDemo } from "../lib/providers";

export const deploymentRoutes = new Hono<AppEnv>();

deploymentRoutes.get("/deployments", async (c) => {
  const { workspace } = requireAuth(c);
  const { page, perPage, offset } = parsePagination(c);
  const projectId = c.req.query("projectId") ?? "";
  const status = c.req.query("status") ?? "";
  const branch = c.req.query("branch") ?? "";
  const triggerKind = c.req.query("triggerKind") ?? "";
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);

  const conditions = ["d.workspace_id = ?"];
  const binds: unknown[] = [workspace.id];
  if (projectId) {
    conditions.push("d.project_id = ?");
    binds.push(projectId);
  }
  if (status && ["queued", "initializing", "running", "success", "failed", "cancelled", "skipped", "unknown"].includes(status)) {
    conditions.push("d.status = ?");
    binds.push(status);
  }
  if (branch) {
    conditions.push("d.branch = ?");
    binds.push(branch);
  }
  if (triggerKind === "production" || triggerKind === "preview") {
    conditions.push("d.trigger_kind = ?");
    binds.push(triggerKind);
  }
  if (q) {
    conditions.push("(d.commit_message LIKE ? OR d.commit_sha LIKE ? OR p.name LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conditions.join(" AND ");
  const total = await dbFirst<{ count: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS count FROM deployments d JOIN projects p ON p.id = d.project_id WHERE ${where}`,
    ...binds
  );
  const rows = await dbAll<Record<string, any>>(
    c.env.DB,
    `SELECT d.*, p.name AS project_name, p.slug AS project_slug
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE ${where} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
    ...binds,
    perPage,
    offset
  );
  return c.json({
    items: rows.map((row) =>
      mapDeployment(row, { name: String(row.project_name), slug: String(row.project_slug) })
    ),
    total: Number(total?.count ?? 0),
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(Number(total?.count ?? 0) / perPage)),
  });
});

deploymentRoutes.get("/deployments/:id", async (c) => {
  const { workspace } = requireAuth(c);
  let row = await loadDeployment(c, c.req.param("id"));
  if (!isDemo(c.env) && ["queued", "initializing", "running"].includes(String(row.status))) {
    await enforceRateLimit(c, `deploy:sync:${workspace.id}`, 300, 5 * 60 * 1000);
    await syncDeployment(c.env, String(row.id), workspace.id).catch(() => undefined);
    row = await loadDeployment(c, c.req.param("id"));
  }
  const project = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM projects WHERE id = ?",
    row.project_id
  );
  if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
  const deployment: DeploymentWithProject = {
    ...mapDeployment(row, { name: String(project.name), slug: String(project.slug) }),
    project: mapProject(project),
  };
  return c.json({ deployment });
});

deploymentRoutes.post("/deployments/:id/sync", async (c) => {
  const { workspace } = requireAuth(c);
  await enforceRateLimit(c, `deploy:sync:${workspace.id}`, 300, 5 * 60 * 1000);
  const result = await syncDeployment(c.env, c.req.param("id"), workspace.id);
  const row = await loadDeployment(c, c.req.param("id"));
  return c.json({ status: result.status, changed: result.changed, deployment: mapDeployment(row) });
});

deploymentRoutes.get("/deployments/:id/logs", async (c) => {
  const { workspace } = requireAuth(c);
  await enforceRateLimit(c, `deploy:logs:${workspace.id}`, 120, 5 * 60 * 1000);
  const force = c.req.query("refresh") === "1";
  const result = await fetchDeploymentLogs(c.env, c.req.param("id"), workspace.id, { force });
  const row = result.deployment;
  const project = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM projects WHERE id = ?",
    row.project_id
  );
  if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
  const detail: DeploymentDetail = {
    ...mapDeployment(row, { name: String(project.name), slug: String(project.slug) }),
    project: mapProject(project),
    logs: result.lines,
    logsSource: result.source,
    logsTruncated: result.truncated,
    logsError: result.error,
  };
  return c.json({ deployment: detail });
});

deploymentRoutes.post("/deployments/:id/cancel", async (c) => {
  const { workspace } = requireAuth(c);
  const deployment = await loadDeployment(c, c.req.param("id"));
  if (isDemo(c.env)) {
    throw new ApiError(409, "DEMO_READ_ONLY", "Cancelling builds is disabled in the demo workspace");
  }
  await cancelDeployment(c.env, String(deployment.id), workspace.id);
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "deployment.cancel",
    targetType: "deployment",
    targetId: deployment.id,
    meta: { projectId: deployment.project_id },
  });
  return c.json({ ok: true });
});

deploymentRoutes.get("/deployments/:id/activity", async (c) => {
  const { workspace } = requireAuth(c);
  const deployment = await loadDeployment(c, c.req.param("id"));
  const project = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT name FROM projects WHERE id = ?",
    deployment.project_id
  );
  const rows = await dbAll<Record<string, any>>(
    c.env.DB,
    `SELECT a.*, p.name AS project_name FROM activities a LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.workspace_id = ? AND (a.project_id = ? OR a.meta_json LIKE ?)
     ORDER BY a.created_at DESC LIMIT 25`,
    workspace.id,
    deployment.project_id,
    `%${deployment.id}%`
  );
  void project;
  return c.json({ items: rows.map(mapActivity) });
});

async function loadDeployment(c: any, id: string): Promise<Record<string, any>> {
  const workspace = c.get("workspace");
  const row = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM deployments WHERE id = ? AND workspace_id = ?",
    id,
    workspace?.id
  );
  if (!row) throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "Deployment not found");
  return row;
}

deploymentRoutes.get("/projects/:id/logs/runtime", async (c) => {
  const { workspace } = requireAuth(c);
  const project = await loadProjectOr404(c, c.req.param("id"));
  if (project.runtime_kind !== "worker") {
    throw new ApiError(
      400,
      "NO_RUNTIME_LOGS",
      "Static sites have no Worker runtime, so no runtime logs exist for this project"
    );
  }
  if (isDemo(c.env)) {
    const payload: RuntimeLogsResponse = {
      lines: [],
      available: false,
      error: "Demo workspace: runtime logs require a real deployed Worker and Cloudflare credentials.",
      projectId: String(project.id),
      workerName: String(project.worker_name),
      windowMinutes: 60,
    };
    return c.json(payload);
  }
  if (!c.env.CLOUDFLARE_API_TOKEN) {
    throw notConfigured("Cloudflare", "Set CLOUDFLARE_API_TOKEN to read Workers Observability logs.");
  }
  await enforceRateLimit(c, `logs:runtime:${workspace.id}`, 60, 5 * 60 * 1000);
  const minutes = Math.min(1440, Math.max(5, Number(c.req.query("minutes") ?? 60) || 60));
  const level = c.req.query("level") ?? "all";
  const search = (c.req.query("q") ?? "").trim().slice(0, 120);
  const to = Date.now();
  const from = to - minutes * 60_000;
  const { client } = await clientForWorkspace(c.env, workspace.id);
  const result = await client.queryRuntimeLogs({
    scriptName: String(project.worker_name),
    from,
    to,
    limit: 200,
    level,
    text: search || undefined,
  });
  const payload: RuntimeLogsResponse = {
    lines: result.lines.slice(0, 200),
    available: result.available,
    error: result.error,
    projectId: String(project.id),
    workerName: String(project.worker_name),
    windowMinutes: minutes,
  };
  return c.json(payload);
});
