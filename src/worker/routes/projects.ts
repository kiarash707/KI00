import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { DomainRecord, EnvVar } from "../../shared/types";
import { requireAuth } from "../lib/auth";
import { ApiError, formatZodError, notConfigured } from "../lib/errors";
import { dbAll, dbFirst, dbRun } from "../lib/db";
import { mapDeployment, mapDomain, mapEnvVar, mapProject } from "../lib/mappers";
import { GitHubClient } from "../lib/github";
import { createProjectSchema, domainSchema, updateProjectSchema, envVarSchema, deploySchema } from "../lib/validation";
import {
  assertWritable,
  enforceRateLimit,
  loadProjectOr404,
  parsePagination,
  workspaceLimitKey,
} from "./helpers";
import { newId, now, slugify } from "../lib/utils";
import { recordActivity, recordAudit } from "../lib/activity";
import { buildCommandsForProject } from "../lib/commands";
import {
  applyRuntimeSecrets,
  clientForWorkspace,
  pushBuildEnvironment,
  startDeployment,
  syncActiveDeployments,
} from "../lib/deploy-engine";
import { decryptValue, encryptValue, maskSecret } from "../lib/crypto";
import { isDemo } from "../lib/providers";

export const projectRoutes = new Hono<AppEnv>();

/** Encrypts with a clear, actionable error when KI00_ENCRYPTION_KEY is missing or malformed. */
async function encryptProjectValue(value: string, key: string | undefined): Promise<string> {
  if (!key) {
    throw new ApiError(503, "ENCRYPTION_KEY_MISSING", "KI00_ENCRYPTION_KEY is not configured", {
      hint: "Set KI00_ENCRYPTION_KEY to 32 random bytes, base64 encoded (openssl rand -base64 32).",
    });
  }
  try {
    return await encryptValue(value, key);
  } catch {
    throw new ApiError(503, "ENCRYPTION_KEY_INVALID", "KI00_ENCRYPTION_KEY cannot encrypt data", {
      hint: "Set KI00_ENCRYPTION_KEY to exactly 32 random bytes, base64 encoded (openssl rand -base64 32), then retry.",
    });
  }
}

projectRoutes.get("/projects", async (c) => {
  const { workspace } = requireAuth(c);
  const { page, perPage, offset } = parsePagination(c);
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const runtime = c.req.query("runtime") ?? "";
  const status = c.req.query("status") ?? "";
  const compatibility = c.req.query("compatibility") ?? "";
  const sort = c.req.query("sort") ?? "updated";

  const conditions = ["workspace_id = ?"];
  const binds: unknown[] = [workspace.id];
  if (q) {
    conditions.push("(name LIKE ? OR repo_name LIKE ? OR repo_owner LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (runtime && ["static", "worker", "container", "unsupported", "unknown"].includes(runtime)) {
    conditions.push("runtime_kind = ?");
    binds.push(runtime);
  }
  if (status && ["active", "deploying", "error", "archived"].includes(status)) {
    conditions.push("status = ?");
    binds.push(status);
  }
  if (
    compatibility &&
    ["compatible", "needs_adapter", "incompatible", "unknown"].includes(compatibility)
  ) {
    conditions.push("compatibility_status = ?");
    binds.push(compatibility);
  }
  const where = conditions.join(" AND ");
  const order =
    sort === "name"
      ? "name ASC"
      : sort === "deployed"
        ? "COALESCE(last_deployed_at, 0) DESC"
        : "updated_at DESC";

  const total = await dbFirst<{ count: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS count FROM projects WHERE ${where}`,
    ...binds
  );
  const rows = await dbAll<Record<string, any>>(
    c.env.DB,
    `SELECT * FROM projects WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...binds,
    perPage,
    offset
  );
  return c.json({
    items: rows.map(mapProject),
    total: Number(total?.count ?? 0),
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(Number(total?.count ?? 0) / perPage)),
  });
});

projectRoutes.post("/projects", async (c) => {
  await assertWritable(c);
  const { user, workspace } = requireAuth(c);
  const parsed = createProjectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  const body = parsed.data;

  if (body.compatibilityStatus !== "compatible" || !["static", "worker"].includes(body.runtimeKind)) {
    throw new ApiError(422, "PROJECT_INCOMPATIBLE", "This project is not compatible with the Workers runtime", {
      hint: "KI00 refuses to create a project that it would silently fail to deploy. Review the compatibility notes and migration options.",
      details: body.compatibilityNotes,
    });
  }

  const github = GitHubClient.fromEnv(c.env);
  let repo;
  try {
    repo = await github.getRepo(body.repoOwner, body.repoName);
  } catch (error) {
    throw new ApiError(422, "REPO_NOT_ACCESSIBLE", "The GitHub repository could not be read", {
      hint:
        error instanceof Error
          ? error.message
          : "Check the repository name and GITHUB_TOKEN repository access.",
    });
  }
  if (repo.archived) {
    throw new ApiError(409, "REPO_ARCHIVED", "This repository is archived and cannot receive new commits");
  }
  const head = await github.getBranchHead(repo.owner, repo.name, body.branch);
  if (!head) {
    throw new ApiError(400, "BRANCH_NOT_FOUND", `Branch "${body.branch}" does not exist`);
  }

  const duplicate = await dbFirst<{ id: string }>(
    c.env.DB,
    "SELECT id FROM projects WHERE workspace_id = ? AND name = ?",
    workspace.id,
    body.name
  );
  if (duplicate) {
    throw new ApiError(409, "PROJECT_EXISTS", "A project with that name already exists");
  }

  const baseSlug = slugify(body.name);
  const suffix = newId("x").slice(-4);
  const workerName = `ki00-${baseSlug}`.slice(0, 44) + `-${suffix}`;
  const commands = buildCommandsForProject({
    project: {
      workerName,
      runtimeKind: body.runtimeKind,
      installCommand: body.installCommand,
      buildCommand: body.buildCommand,
      outputDir: body.outputDir,
      spaFallback: body.spaFallback,
      hasWranglerConfig: body.hasWranglerConfig,
    },
    wranglerVersion: c.env.KI00_WRANGLER_VERSION ?? "4.151.1",
  });

  const id = newId("prj");
  const ts = now();
  await dbRun(
    c.env.DB,
    `INSERT INTO projects (
      id, workspace_id, name, slug, description, repo_owner, repo_name, repo_id, repo_private,
      default_branch, branch, project_type, framework, language, runtime_kind, runtime_detail,
      compatibility_status, compatibility_notes, build_command, install_command, output_dir, root_dir,
      deploy_command, worker_name, workers_dev_url, spa_fallback, auto_deploy, build_caching,
      has_wrangler_config, wrangler_has_routes, status, detected_env_keys, detection_json,
      created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    id,
    workspace.id,
    body.name,
    baseSlug,
    body.description ?? "",
    repo.owner,
    repo.name,
    String(repo.id),
    repo.private ? 1 : 0,
    repo.defaultBranch,
    body.branch,
    body.projectType,
    body.framework,
    body.language,
    body.runtimeKind,
    body.runtimeDetail,
    body.compatibilityStatus,
    JSON.stringify(body.compatibilityNotes ?? []),
    body.buildCommand,
    body.installCommand,
    body.outputDir,
    body.rootDir,
    commands.deployCommand,
    workerName,
    body.spaFallback ? 1 : 0,
    body.autoDeploy ? 1 : 0,
    1,
    body.hasWranglerConfig ? 1 : 0,
    body.wranglerHasRoutes ? 1 : 0,
    JSON.stringify(body.detectedEnvKeys ?? []),
    JSON.stringify({
      compatibilityNotes: body.compatibilityNotes ?? [],
      hasWranglerConfig: body.hasWranglerConfig,
      wranglerHasRoutes: body.wranglerHasRoutes,
      migratedFrom: null,
      createdAt: ts,
    }),
    user.id,
    ts,
    ts
  );

  const row = await dbFirst<Record<string, any>>(c.env.DB, "SELECT * FROM projects WHERE id = ?", id);
  if (!row) throw new ApiError(500, "PROJECT_CREATE_FAILED", "Project could not be created");

  await recordActivity(c.env.DB, {
    workspaceId: workspace.id,
    projectId: id,
    type: "project.created",
    level: "success",
    message: `Project ${body.name} created from ${repo.fullName}`,
    meta: { runtime: body.runtimeKind, framework: body.framework },
    actor: user.email,
  });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "project.create",
    targetType: "project",
    targetId: id,
    meta: {
      repo: repo.fullName,
      branch: body.branch,
      runtime: body.runtimeKind,
      framework: body.framework,
    },
  });

  const project = mapProject(row);
  return c.json({ project }, 201);
});

projectRoutes.get("/projects/:id", async (c) => {
  requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const [recent, counts, domains] = await Promise.all([
    dbAll<Record<string, any>>(
      c.env.DB,
      "SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT 6",
      row.id
    ),
    dbFirst<{ envCount: number; domainCount: number; deployCount: number }>(
      c.env.DB,
      `SELECT
        (SELECT COUNT(*) FROM env_vars WHERE project_id = ?) AS envCount,
        (SELECT COUNT(*) FROM domains WHERE project_id = ?) AS domainCount,
        (SELECT COUNT(*) FROM deployments WHERE project_id = ?) AS deployCount`,
      row.id,
      row.id,
      row.id
    ),
    dbAll<Record<string, any>>(c.env.DB, "SELECT * FROM domains WHERE project_id = ?", row.id),
  ]);
  return c.json({
    project: mapProject(row),
    recentDeployments: recent.map((deployment) =>
      mapDeployment(deployment, { name: String(row.name), slug: String(row.slug) })
    ),
    counts: {
      envVars: Number(counts?.envCount ?? 0),
      domains: Number(counts?.domainCount ?? 0),
      deployments: Number(counts?.deployCount ?? 0),
    },
    domains: domains.map(mapDomain),
  });
});

projectRoutes.patch("/projects/:id", async (c) => {
  await assertWritable(c);
  const { workspace, user } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const parsed = updateProjectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  const body = parsed.data;

  if (body.name && body.name !== row.name) {
    const duplicate = await dbFirst<{ id: string }>(
      c.env.DB,
      "SELECT id FROM projects WHERE workspace_id = ? AND name = ? AND id != ?",
      workspace.id,
      body.name,
      row.id
    );
    if (duplicate) throw new ApiError(409, "PROJECT_EXISTS", "A project with that name already exists");
  }

  const fields: string[] = [];
  const binds: unknown[] = [];
  const assign = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    binds.push(value);
  };
  if (body.name !== undefined) assign("name", body.name);
  if (body.description !== undefined) assign("description", body.description);
  if (body.branch !== undefined) assign("branch", body.branch);
  if (body.installCommand !== undefined) assign("install_command", body.installCommand);
  if (body.buildCommand !== undefined) assign("build_command", body.buildCommand);
  if (body.outputDir !== undefined) assign("output_dir", body.outputDir);
  if (body.rootDir !== undefined) assign("root_dir", body.rootDir);
  if (body.autoDeploy !== undefined) assign("auto_deploy", body.autoDeploy ? 1 : 0);
  if (body.buildCaching !== undefined) assign("build_caching", body.buildCaching ? 1 : 0);
  if (body.spaFallback !== undefined) assign("spa_fallback", body.spaFallback ? 1 : 0);
  assign("updated_at", now());

  await dbRun(
    c.env.DB,
    `UPDATE projects SET ${fields.join(", ")} WHERE id = ?`,
    ...binds,
    row.id
  );
  await recordActivity(c.env.DB, {
    workspaceId: workspace.id,
    projectId: row.id,
    type: "project.updated",
    level: "info",
    message: `Settings updated for ${row.name}`,
    actor: user.email,
  });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "project.update",
    targetType: "project",
    targetId: row.id,
    meta: { changed: Object.keys(body) },
  });
  const updated = await dbFirst<Record<string, any>>(c.env.DB, "SELECT * FROM projects WHERE id = ?", row.id);
  return c.json({ project: updated ? mapProject(updated) : null });
});

projectRoutes.delete("/projects/:id", async (c) => {
  await assertWritable(c);
  const { workspace, user } = requireAuth(c);
  if (!["owner", "admin"].includes(workspace.role)) {
    throw new ApiError(403, "FORBIDDEN", "Only workspace owners or admins can delete projects");
  }
  const row = await loadProjectOr404(c, c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { confirmName?: string };
  if (body.confirmName !== row.name) {
    throw new ApiError(400, "CONFIRMATION_REQUIRED", "Type the project name exactly to confirm deletion");
  }

  const warnings: string[] = [];
  if (!isDemo(c.env) && c.env.CLOUDFLARE_API_TOKEN) {
    try {
      const { client } = await clientForWorkspace(c.env, workspace.id);
      try {
        const domains = await client.listDomains(String(row.worker_name));
        for (const domain of domains) {
          try {
            await client.removeDomain(domain.id);
          } catch (error) {
            warnings.push(
              `Custom domain ${domain.hostname} could not be removed: ${error instanceof Error ? error.message : "unknown error"}`
            );
          }
        }
      } catch (error) {
        warnings.push(
          `Custom domains could not be listed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
      try {
        await client.deleteWorker(String(row.worker_name));
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404) {
          warnings.push(
            `The Cloudflare Worker was not deleted: ${error instanceof Error ? error.message : "unknown error"}`
          );
        }
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Cloudflare cleanup failed");
    }
  }

  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "project.delete",
    targetType: "project",
    targetId: row.id,
    meta: { name: row.name, worker: row.worker_name, warnings },
  });
  await recordActivity(c.env.DB, {
    workspaceId: workspace.id,
    type: "project.deleted",
    level: "warn",
    message: `Project ${row.name} deleted`,
    actor: user.email,
  });
  await dbRun(c.env.DB, "DELETE FROM projects WHERE id = ?", row.id);
  return c.json({ ok: true, warnings });
});

projectRoutes.post("/projects/:id/deploy", async (c) => {
  await assertWritable(c);
  const { workspace, user } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const parsed = deploySchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) throw formatZodError(parsed.error);
  await enforceRateLimit(c, workspaceLimitKey(c, "deploy"), 12, 60 * 60 * 1000);

  const deploymentId = await startDeployment(c.env, row, {
    branch: parsed.data.branch,
    commitSha: parsed.data.commitSha,
    triggerKind: parsed.data.triggerKind,
    acknowledgeRepoConfig: parsed.data.acknowledgeRepoConfig,
    requestedBy: user.id,
  });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "deployment.start",
    targetType: "deployment",
    targetId: deploymentId,
    meta: {
      projectId: row.id,
      branch: parsed.data.branch ?? row.branch,
      commit: parsed.data.commitSha ?? null,
      triggerKind: parsed.data.triggerKind,
    },
  });
  const deployment = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM deployments WHERE id = ?",
    deploymentId
  );
  return c.json(
    {
      deployment: deployment
        ? mapDeployment(deployment, { name: String(row.name), slug: String(row.slug) })
        : null,
    },
    202
  );
});

projectRoutes.post("/projects/:id/rollback", async (c) => {
  await assertWritable(c);
  const { workspace, user } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { deploymentId?: string };
  if (!body.deploymentId) {
    throw new ApiError(400, "DEPLOYMENT_REQUIRED", "Choose a deployment to roll back to");
  }
  const target = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM deployments WHERE id = ? AND project_id = ?",
    body.deploymentId,
    row.id
  );
  if (!target) throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "Deployment not found");
  if (target.status !== "success") {
    throw new ApiError(409, "ROLLBACK_REQUIRES_SUCCESS", "Only a successful deployment can be rolled back to");
  }
  if (!target.commit_sha) {
    throw new ApiError(409, "ROLLBACK_NO_COMMIT", "That deployment has no recorded commit SHA");
  }
  await enforceRateLimit(c, workspaceLimitKey(c, "deploy"), 12, 60 * 60 * 1000);
  const deploymentId = await startDeployment(c.env, row, {
    branch: target.branch,
    commitSha: target.commit_sha,
    triggerKind: "production",
    rollbackOf: target.id,
    acknowledgeRepoConfig: true,
    requestedBy: user.id,
  });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "deployment.rollback",
    targetType: "deployment",
    targetId: deploymentId,
    meta: { projectId: row.id, rollbackOf: target.id, commit: target.commit_sha },
  });
  return c.json({ ok: true, deploymentId, rollbackOf: target.id }, 202);
});

projectRoutes.post("/projects/:id/sync", async (c) => {
  const { workspace } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  if (isDemo(c.env)) {
    return c.json({ synced: 0, demo: true });
  }
  const changed = await syncActiveDeployments(c.env, workspace.id, 5, String(row.id));
  const updated = await dbFirst<Record<string, any>>(c.env.DB, "SELECT * FROM projects WHERE id = ?", row.id);
  return c.json({ synced: changed, project: updated ? mapProject(updated) : null });
});

// ── Variables ───────────────────────────────────────────────────────────────

projectRoutes.get("/projects/:id/variables", async (c) => {
  requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const rows = await dbAll<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM env_vars WHERE project_id = ? ORDER BY scope, key",
    row.id
  );
  const items: EnvVar[] = [];
  for (const envRow of rows) {
    let masked = "••••";
    try {
      masked = maskSecret(await decryptValue(String(envRow.value_enc), c.env.KI00_ENCRYPTION_KEY));
    } catch {
      masked = "[cannot decrypt]";
    }
    items.push(mapEnvVar({ ...envRow, masked_value: masked }));
  }
  return c.json({
    items,
    hint:
      row.runtime_kind === "worker"
        ? "Runtime variables are applied as encrypted Worker secret bindings after a successful deployment. Build-time variables are pushed to the Cloudflare build trigger."
        : "Static sites have no runtime; variables are only available during the build.",
  });
});

projectRoutes.post("/projects/:id/variables", async (c) => {
  await assertWritable(c);
  const { workspace, user } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const parsed = envVarSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  const body = parsed.data;
  const runtimeAllowed = row.runtime_kind === "worker" && body.scope === "production";
  const useRuntime = runtimeAllowed ? body.useRuntime : false;

  const duplicate = await dbFirst<{ id: string }>(
    c.env.DB,
    "SELECT id FROM env_vars WHERE project_id = ? AND key = ? AND scope = ?",
    row.id,
    body.key,
    body.scope
  );
  if (duplicate) {
    throw new ApiError(409, "VARIABLE_EXISTS", `${body.key} already exists in ${body.scope}`);
  }
  const encrypted = await encryptProjectValue(body.value, c.env.KI00_ENCRYPTION_KEY);
  const id = newId("env");
  const ts = now();
  await dbRun(
    c.env.DB,
    `INSERT INTO env_vars (id, project_id, key, value_enc, is_secret, scope, use_build, use_runtime, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    row.id,
    body.key,
    encrypted,
    body.isSecret ? 1 : 0,
    body.scope,
    body.useBuild ? 1 : 0,
    useRuntime ? 1 : 0,
    ts,
    ts
  );
  const warnings: string[] = [];
  if (!runtimeAllowed && body.useRuntime) {
    warnings.push("Runtime bindings are only applied to Workers on the production scope; this value is build-time only.");
  }
  const buildPush = await pushBuildEnvironment(c.env, row);
  if (!buildPush.ok && buildPush.error) warnings.push(buildPush.error);
  if (useRuntime) {
    const runtime = await applyRuntimeSecrets(c.env, row);
    if (!runtime.ok && runtime.error) warnings.push(runtime.error);
  }
  await recordActivity(c.env.DB, {
    workspaceId: workspace.id,
    projectId: row.id,
    type: "env.created",
    level: "info",
    message: `Variable ${body.key} added to ${row.name} (${body.scope})`,
    actor: user.email,
  });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "env.create",
    targetType: "env_var",
    targetId: id,
    meta: { projectId: row.id, key: body.key, scope: body.scope, useBuild: body.useBuild, useRuntime },
  });
  const createdRow = await dbFirst<Record<string, any>>(c.env.DB, "SELECT * FROM env_vars WHERE id = ?", id);
  return c.json(
    {
      variable: createdRow
        ? mapEnvVar({ ...createdRow, masked_value: maskSecret(body.value) })
        : null,
      warnings,
    },
    201
  );
});

projectRoutes.patch("/projects/:id/variables/:varId", async (c) => {
  await assertWritable(c);
  const { workspace, user } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const variable = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM env_vars WHERE id = ? AND project_id = ?",
    c.req.param("varId"),
    row.id
  );
  if (!variable) throw new ApiError(404, "VARIABLE_NOT_FOUND", "Variable not found");
  const parsed = envVarSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  const body = parsed.data;
  if (body.key && body.key !== variable.key) {
    throw new ApiError(400, "VARIABLE_KEY_IMMUTABLE", "Delete and re-create the variable to rename it");
  }
  const scope = body.scope ?? variable.scope;
  if (scope !== variable.scope) {
    const duplicate = await dbFirst<{ id: string }>(
      c.env.DB,
      "SELECT id FROM env_vars WHERE project_id = ? AND key = ? AND scope = ? AND id != ?",
      row.id,
      variable.key,
      scope,
      variable.id
    );
    if (duplicate) throw new ApiError(409, "VARIABLE_EXISTS", `${variable.key} already exists in ${scope}`);
  }
  const runtimeAllowed = row.runtime_kind === "worker" && scope === "production";
  const useRuntime = runtimeAllowed ? (body.useRuntime ?? Boolean(variable.use_runtime)) : false;
  const encrypted =
    typeof body.value === "string" && body.value.length > 0
      ? await encryptProjectValue(body.value, c.env.KI00_ENCRYPTION_KEY)
      : variable.value_enc;

  await dbRun(
    c.env.DB,
    `UPDATE env_vars SET value_enc = ?, is_secret = ?, scope = ?, use_build = ?, use_runtime = ?, updated_at = ?
     WHERE id = ?`,
    encrypted,
    (body.isSecret ?? Boolean(variable.is_secret)) ? 1 : 0,
    scope,
    (body.useBuild ?? Boolean(variable.use_build)) ? 1 : 0,
    useRuntime ? 1 : 0,
    now(),
    variable.id
  );
  const warnings: string[] = [];
  const buildPush = await pushBuildEnvironment(c.env, row);
  if (!buildPush.ok && buildPush.error) warnings.push(buildPush.error);
  if (useRuntime) {
    const runtime = await applyRuntimeSecrets(c.env, row);
    if (!runtime.ok && runtime.error) warnings.push(runtime.error);
  }
  await recordActivity(c.env.DB, {
    workspaceId: workspace.id,
    projectId: row.id,
    type: "env.updated",
    level: "info",
    message: `Variable ${variable.key} updated for ${row.name}`,
    actor: user.email,
  });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "env.update",
    targetType: "env_var",
    targetId: variable.id,
    meta: { projectId: row.id, key: variable.key, scope, changedValue: Boolean(body.value) },
  });
  const updated = await dbFirst<Record<string, any>>(c.env.DB, "SELECT * FROM env_vars WHERE id = ?", variable.id);
  let masked = "[cannot decrypt]";
  try {
    masked = maskSecret(await decryptValue(String(updated?.value_enc), c.env.KI00_ENCRYPTION_KEY));
  } catch {
    /* handled by UI */
  }
  return c.json({
    variable: updated ? mapEnvVar({ ...updated, masked_value: masked }) : null,
    warnings,
  });
});

projectRoutes.delete("/projects/:id/variables/:varId", async (c) => {
  await assertWritable(c);
  const { workspace, user } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const variable = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM env_vars WHERE id = ? AND project_id = ?",
    c.req.param("varId"),
    row.id
  );
  if (!variable) throw new ApiError(404, "VARIABLE_NOT_FOUND", "Variable not found");
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
  if (!body.confirm) {
    throw new ApiError(400, "CONFIRMATION_REQUIRED", "Confirm variable deletion");
  }
  await dbRun(c.env.DB, "DELETE FROM env_vars WHERE id = ?", variable.id);
  const warnings: string[] = [];
  const remaining = await dbAll<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM env_vars WHERE project_id = ? AND key = ? AND use_runtime = 1",
    row.id,
    variable.key
  );
  if (row.runtime_kind === "worker" && Boolean(variable.use_runtime) && remaining.length === 0) {
    try {
      const { client } = await clientForWorkspace(c.env, workspace.id);
      await client.deleteWorkerSecret(String(row.worker_name), String(variable.key));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404) {
        warnings.push(
          `The Worker secret was not removed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
    }
  }
  const buildPush = await pushBuildEnvironment(c.env, row);
  if (!buildPush.ok && buildPush.error) warnings.push(buildPush.error);
  await recordActivity(c.env.DB, {
    workspaceId: workspace.id,
    projectId: row.id,
    type: "env.deleted",
    level: "warn",
    message: `Variable ${variable.key} deleted from ${row.name}`,
    actor: user.email,
  });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "env.delete",
    targetType: "env_var",
    targetId: variable.id,
    meta: { projectId: row.id, key: variable.key, scope: variable.scope },
  });
  return c.json({ ok: true, warnings });
});

// ── Domains ────────────────────────────────────────────────────────────────

projectRoutes.get("/projects/:id/zones", async (c) => {
  const { workspace } = requireAuth(c);
  if (!c.env.CLOUDFLARE_API_TOKEN) {
    throw notConfigured("Cloudflare", "Set CLOUDFLARE_API_TOKEN to manage custom domains.");
  }
  const { client } = await clientForWorkspace(c.env, workspace.id);
  const zones = await client.listZones();
  return c.json({
    zones: zones.map((zone) => ({ id: zone.id, name: zone.name, status: zone.status })),
  });
});

projectRoutes.get("/projects/:id/domains", async (c) => {
  const { workspace } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const refresh = c.req.query("refresh") === "1";
  let refreshError: string | null = null;
  if (refresh && !isDemo(c.env) && c.env.CLOUDFLARE_API_TOKEN) {
    try {
      const { client } = await clientForWorkspace(c.env, workspace.id);
      const domains = await client.listDomains(String(row.worker_name));
      for (const domainRecord of domains) {
        const local = await dbFirst<Record<string, any>>(
          c.env.DB,
          "SELECT * FROM domains WHERE project_id = ? AND hostname = ?",
          row.id,
          domainRecord.hostname
        );
        if (!local) continue;
        const status =
          domainRecord.enabled === true || Boolean(domainRecord.cert_id)
            ? "active"
            : "pending";
        await dbRun(
          c.env.DB,
          "UPDATE domains SET status = ?, cloudflare_domain_id = ?, zone_id = ?, zone_name = ?, verified_at = ? WHERE id = ?",
          status,
          domainRecord.id,
          domainRecord.zone_id ?? local.zone_id,
          domainRecord.zone_name ?? local.zone_name,
          status === "active" ? now() : null,
          local.id
        );
      }
    } catch (error) {
      refreshError = error instanceof Error ? error.message : "Domain status could not be refreshed";
    }
  }
  const domains = await dbAll<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM domains WHERE project_id = ? ORDER BY created_at DESC",
    row.id
  );
  return c.json({
    items: domains.map((domain) => ({
      ...mapDomain(domain),
      autoAttached: Boolean(domain.cloudflare_domain_id),
    })) as (DomainRecord & { autoAttached: boolean })[],
    refreshError,
  });
});

projectRoutes.post("/projects/:id/domains", async (c) => {
  await assertWritable(c);
  const { workspace, user } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const parsed = domainSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  await enforceRateLimit(c, workspaceLimitKey(c, "domain:add"), 20, 60 * 60 * 1000);
  const hostname = parsed.data.hostname;
  if (!c.env.CLOUDFLARE_API_TOKEN) {
    throw notConfigured("Cloudflare", "Set CLOUDFLARE_API_TOKEN before adding a custom domain.");
  }
  const duplicate = await dbFirst<{ id: string }>(
    c.env.DB,
    "SELECT id FROM domains WHERE project_id = ? AND hostname = ?",
    row.id,
    hostname
  );
  if (duplicate) throw new ApiError(409, "DOMAIN_EXISTS", `${hostname} is already attached to this project`);

  const { client } = await clientForWorkspace(c.env, workspace.id);
  const zones = await client.listZones();
  const zone = zones
    .filter((candidate) => hostname === candidate.name || hostname.endsWith(`.${candidate.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];

  if (!zone) {
    const instructions = [
      `Cloudflare Workers Custom Domains require the DNS zone to be active in this Cloudflare account.`,
      `The zone for ${hostname} is not in account ${workspace.cloudflareAccountId ?? "(unknown)"}.`,
      `Option A: add the domain as a zone in Cloudflare and move its nameservers, then add the domain here again.`,
      `Option B: create the record in your external DNS provider yourself. KI00 has not created or changed any DNS record.`,
      `When the zone is active in this account, KI00 can attach the Custom Domain and Cloudflare will create the DNS record automatically.`,
    ].join("\n");
    const id = newId("dom");
    await dbRun(
      c.env.DB,
      `INSERT INTO domains (id, project_id, hostname, zone_id, zone_name, cloudflare_domain_id, status, dns_instructions, created_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'instructions', ?, ?)`,
      id,
      row.id,
      hostname,
      instructions,
      now()
    );
    await recordActivity(c.env.DB, {
      workspaceId: workspace.id,
      projectId: row.id,
      type: "domain.instructions",
      level: "warn",
      message: `Domain ${hostname} needs manual DNS setup; no record was created`,
      actor: user.email,
    });
    const domain = await dbFirst<Record<string, any>>(c.env.DB, "SELECT * FROM domains WHERE id = ?", id);
    return c.json({ domain: domain ? mapDomain(domain) : null, attached: false }, 201);
  }

  let attached: Awaited<ReturnType<typeof client.attachDomain>>;
  try {
    attached = await client.attachDomain({
      hostname,
      service: String(row.worker_name),
      zoneId: zone.id,
    });
  } catch (error) {
    throw new ApiError(502, "DOMAIN_ATTACH_FAILED", "Cloudflare could not attach this custom domain", {
      hint:
        error instanceof Error
          ? error.message
          : "Check that the zone is active and the token has Workers Routes:Edit for this zone.",
    });
  }

  const id = newId("dom");
  const status = attached.enabled === false ? "pending" : "active";
  await dbRun(
    c.env.DB,
    `INSERT INTO domains (id, project_id, hostname, zone_id, zone_name, cloudflare_domain_id, status, dns_instructions, created_at, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    row.id,
    hostname,
    zone.id,
    zone.name,
    attached.id,
    status,
    "Cloudflare manages the DNS record for this Workers Custom Domain. Certificate issuance can take a few minutes.",
    now(),
    status === "active" ? now() : null
  );
  await recordActivity(c.env.DB, {
    workspaceId: workspace.id,
    projectId: row.id,
    type: "domain.attached",
    level: "success",
    message: `Custom domain ${hostname} attached to ${row.name}`,
    actor: user.email,
  });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "domain.attach",
    targetType: "domain",
    targetId: id,
    meta: { projectId: row.id, hostname, zone: zone.name },
  });
  const domain = await dbFirst<Record<string, any>>(c.env.DB, "SELECT * FROM domains WHERE id = ?", id);
  return c.json({ domain: domain ? mapDomain(domain) : null, attached: true }, 201);
});

projectRoutes.delete("/projects/:id/domains/:domainId", async (c) => {
  await assertWritable(c);
  const { workspace, user } = requireAuth(c);
  const row = await loadProjectOr404(c, c.req.param("id"));
  const domain = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM domains WHERE id = ? AND project_id = ?",
    c.req.param("domainId"),
    row.id
  );
  if (!domain) throw new ApiError(404, "DOMAIN_NOT_FOUND", "Domain not found");
  const body = (await c.req.json().catch(() => ({}))) as { confirmHostname?: string };
  if (body.confirmHostname !== domain.hostname) {
    throw new ApiError(400, "CONFIRMATION_REQUIRED", "Type the hostname exactly to confirm removal");
  }
  if (domain.cloudflare_domain_id) {
    try {
      const { client } = await clientForWorkspace(c.env, workspace.id);
      await client.removeDomain(String(domain.cloudflare_domain_id));
    } catch (error) {
      throw new ApiError(502, "DOMAIN_REMOVE_FAILED", "Cloudflare could not remove this domain", {
        hint: error instanceof Error ? error.message : "Check Workers Routes:Edit permission for the zone.",
      });
    }
  }
  await dbRun(c.env.DB, "DELETE FROM domains WHERE id = ?", domain.id);
  await recordActivity(c.env.DB, {
    workspaceId: workspace.id,
    projectId: row.id,
    type: "domain.removed",
    level: "warn",
    message: `Custom domain ${domain.hostname} removed from ${row.name}`,
    actor: user.email,
  });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "domain.remove",
    targetType: "domain",
    targetId: domain.id,
    meta: { projectId: row.id, hostname: domain.hostname },
  });
  return c.json({ ok: true });
});
