import type { DeploymentStatus, LogLine } from "../../shared/types";
import type { Env } from "../env";
import { CloudflareClient, type CloudflareBuild } from "./cloudflare";
import { buildCommandsForProject } from "./commands";
import { decryptValue } from "./crypto";
import { dbAll, dbFirst, dbRun, getSetting, setSetting } from "./db";
import { ApiError, ProviderError } from "./errors";
import { GitHubClient } from "./github";
import { recordActivity } from "./activity";
import { newId, now, redactSecrets, truncate } from "./utils";

type ProjectRow = Record<string, any>;

export interface DeploymentResources {
  client: CloudflareClient;
  accountId: string;
  workerTag: string;
  buildTokenUuid: string;
  repoConnectionUuid: string;
  productionTriggerUuid: string;
  previewTriggerUuid: string | null;
  url: string | null;
  buildCommand: string;
  deployCommand: string;
}

export async function resolveAccountId(env: Env, workspaceId: string): Promise<string | null> {
  const workspace = await dbFirst<{ cloudflare_account_id: string | null }>(
    env.DB,
    "SELECT cloudflare_account_id FROM workspaces WHERE id = ?",
    workspaceId
  );
  return (
    workspace?.cloudflare_account_id ??
    env.CLOUDFLARE_ACCOUNT_ID ??
    env.KI00_DEFAULT_ACCOUNT_ID ??
    null
  );
}

export async function clientForWorkspace(
  env: Env,
  workspaceId: string
): Promise<{ client: CloudflareClient; accountId: string }> {
  const accountId = await resolveAccountId(env, workspaceId);
  if (!accountId) {
    throw new ApiError(424, "CLOUDFLARE_ACCOUNT_MISSING", "No Cloudflare account is connected", {
      hint: "Add CLOUDFLARE_ACCOUNT_ID as a Worker secret or variable, then retry.",
    });
  }
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new ApiError(424, "CLOUDFLARE_NOT_CONFIGURED", "Cloudflare is not connected", {
      hint: "Set the CLOUDFLARE_API_TOKEN Worker secret. See docs/CLOUDFLARE_SETUP.md.",
    });
  }
  return {
    client: new CloudflareClient({ token: env.CLOUDFLARE_API_TOKEN, accountId }),
    accountId,
  };
}

export async function getProjectRow(
  env: Env,
  workspaceId: string,
  projectId: string
): Promise<ProjectRow> {
  const project = await dbFirst<ProjectRow>(
    env.DB,
    "SELECT * FROM projects WHERE id = ? AND workspace_id = ?",
    projectId,
    workspaceId
  );
  if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
  return project;
}

export async function ensureDeploymentResources(
  env: Env,
  project: ProjectRow
): Promise<DeploymentResources> {
  if (project.runtime_kind !== "static" && project.runtime_kind !== "worker") {
    throw new ApiError(
      422,
      "RUNTIME_UNSUPPORTED",
      "This project does not target a supported Workers runtime",
      { hint: "See the compatibility notes on the project and docs/RUNTIME_COMPATIBILITY.md." }
    );
  }
  if (project.compatibility_status !== "compatible") {
    throw new ApiError(
      422,
      "PROJECT_INCOMPATIBLE",
      "This project needs code changes before it can deploy to Workers",
      {
        hint: "Open the project's compatibility panel. KI00 does not convert incompatible projects automatically.",
        details: JSON.parse(project.compatibility_notes || "[]"),
      }
    );
  }

  const { client, accountId } = await clientForWorkspace(env, project.workspace_id);
  const github = GitHubClient.fromEnv(env);
  const [repo, workersSubdomain] = await Promise.all([
    github.getRepo(project.repo_owner, project.repo_name),
    client.getWorkersSubdomain(),
  ]);

  const workerTag =
    project.worker_tag ?? (await client.ensurePlaceholderWorker(project.worker_name, compatibilityDate()));

  let buildTokenUuid: string | null =
    env.KI00_BUILD_TOKEN_UUID ?? project.build_token_uuid ?? null;
  if (!buildTokenUuid) {
    buildTokenUuid = await getSetting(env.DB, `cf:build-token:${accountId}`);
  }
  if (!buildTokenUuid) {
    const token = await client.ensureBuildToken({
      uuid: env.KI00_BUILD_TOKEN_UUID ?? null,
      secret: env.KI00_BUILD_TOKEN_SECRET ?? null,
      tokenId: env.KI00_BUILD_TOKEN_ID ?? null,
    });
    buildTokenUuid = token.uuid;
    await setSetting(env.DB, `cf:build-token:${accountId}`, buildTokenUuid);
  }

  const ownerId = await github.getRepoOwnerId(project.repo_owner, project.repo_name);
  const repoConnectionUuid =
    project.repo_connection_uuid ??
    (await client.ensureRepoConnection({
      providerAccountId: String(ownerId),
      providerAccountName: project.repo_owner,
      repoId: String(repo.id),
      repoName: project.repo_name,
    }));

  const commands = buildCommandsForProject({
    project: {
      workerName: project.worker_name,
      runtimeKind: project.runtime_kind,
      installCommand: project.install_command,
      buildCommand: project.build_command,
      outputDir: project.output_dir,
      spaFallback: Boolean(project.spa_fallback),
      hasWranglerConfig: Boolean(project.has_wrangler_config),
    },
    wranglerVersion: env.KI00_WRANGLER_VERSION ?? "4.151.1",
  });

  const triggers = await client.listTriggers(workerTag).catch(() => []);
  const productionName = "KI00 production";
  const existingProduction = triggers.find(
    (trigger) =>
      trigger.trigger_name === productionName ||
      (trigger.branch_includes?.includes(project.branch) && !trigger.branch_excludes?.includes("*"))
  );

  let productionTriggerUuid: string;
  if (existingProduction?.trigger_uuid) {
    productionTriggerUuid = existingProduction.trigger_uuid;
    await client.updateTrigger(productionTriggerUuid, {
      buildCommand: commands.buildCommand,
      deployCommand: commands.deployCommand,
      rootDirectory: project.root_dir || "/",
      branchIncludes: [project.branch],
      branchExcludes: [],
      buildCaching: Boolean(project.build_caching),
    });
  } else {
    const created = await client.createTrigger({
      workerTag,
      repoConnectionUuid,
      buildTokenUuid,
      name: productionName,
      buildCommand: commands.buildCommand,
      deployCommand: commands.deployCommand,
      rootDirectory: project.root_dir || "/",
      branchIncludes: [project.branch],
      branchExcludes: [],
      buildCaching: Boolean(project.build_caching),
    });
    if (!created.trigger_uuid) {
      throw new ApiError(502, "TRIGGER_CREATE_FAILED", "Cloudflare did not return a trigger id", {
        hint: "Retry the deployment. If it repeats, check Workers Builds permissions.",
      });
    }
    productionTriggerUuid = created.trigger_uuid;
  }

  let previewTriggerUuid: string | null = project.preview_trigger_uuid ?? null;
  const existingPreview = triggers.find(
    (trigger) => trigger.trigger_name === "KI00 preview" || trigger.branch_includes?.includes("*")
  );
  if (existingPreview?.trigger_uuid) {
    previewTriggerUuid = existingPreview.trigger_uuid;
    await client
      .updateTrigger(previewTriggerUuid, {
        buildCommand: commands.buildCommand,
        deployCommand: commands.previewCommand,
        rootDirectory: project.root_dir || "/",
        branchIncludes: ["*"],
        branchExcludes: [project.branch],
        buildCaching: Boolean(project.build_caching),
      })
      .catch(() => undefined);
  } else if (!previewTriggerUuid && triggers.length < 2) {
    try {
      const created = await client.createTrigger({
        workerTag,
        repoConnectionUuid,
        buildTokenUuid,
        name: "KI00 preview",
        buildCommand: commands.buildCommand,
        deployCommand: commands.previewCommand,
        rootDirectory: project.root_dir || "/",
        branchIncludes: ["*"],
        branchExcludes: [project.branch],
        buildCaching: Boolean(project.build_caching),
      });
      previewTriggerUuid = created.trigger_uuid ?? null;
    } catch {
      previewTriggerUuid = null;
    }
  }

  await applyBuildEnvironment(env, project, client, productionTriggerUuid, "production");
  if (previewTriggerUuid) {
    await applyBuildEnvironment(env, project, client, previewTriggerUuid, "preview");
    await client
      .setTriggerEnvironmentVariables(previewTriggerUuid, {
        KI00_PREVIEW_BUILD: { value: "1", isSecret: false },
      })
      .catch(() => undefined);
  }

  const url =
    project.workers_dev_url ??
    (workersSubdomain
      ? `https://${project.worker_name}.${workersSubdomain}.workers.dev`
      : null);
  await dbRun(
    env.DB,
    `UPDATE projects SET worker_tag = ?, build_token_uuid = ?, repo_connection_uuid = ?,
     production_trigger_uuid = ?, preview_trigger_uuid = ?, deploy_command = ?,
     workers_dev_url = COALESCE(workers_dev_url, ?), updated_at = ?
     WHERE id = ?`,
    workerTag,
    buildTokenUuid,
    repoConnectionUuid,
    productionTriggerUuid,
    previewTriggerUuid,
    commands.deployCommand,
    url,
    now(),
    project.id
  );
  await setSetting(env.DB, `cf:build-token:${accountId}`, buildTokenUuid).catch(() => undefined);

  return {
    client,
    accountId,
    workerTag,
    buildTokenUuid,
    repoConnectionUuid,
    productionTriggerUuid,
    previewTriggerUuid,
    url,
    buildCommand: commands.buildCommand,
    deployCommand: commands.deployCommand,
  };
}

function compatibilityDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function buildEnvForProject(
  env: Env,
  projectId: string,
  scope: "production" | "preview"
): Promise<{ variables: Record<string, { value: string; isSecret: boolean }>; errors: string[] }> {
  const rows = await dbAll<{
    key: string;
    value_enc: string;
    is_secret: number;
    use_build: number;
  }>(
    env.DB,
    "SELECT key, value_enc, is_secret, use_build FROM env_vars WHERE project_id = ? AND scope = ? ORDER BY key",
    projectId,
    scope
  );
  const variables: Record<string, { value: string; isSecret: boolean }> = {};
  const errors: string[] = [];
  for (const row of rows) {
    if (!row.use_build) continue;
    try {
      variables[row.key] = {
        value: await decryptValue(row.value_enc, env.KI00_ENCRYPTION_KEY),
        isSecret: Boolean(row.is_secret),
      };
    } catch {
      errors.push(`Could not decrypt ${row.key}`);
    }
  }
  return { variables, errors };
}

async function applyBuildEnvironment(
  env: Env,
  project: ProjectRow,
  client: CloudflareClient,
  triggerUuid: string,
  scope: "production" | "preview"
): Promise<void> {
  const { variables, errors } = await buildEnvForProject(env, project.id, scope);
  if (errors.length > 0) {
    throw new ApiError(500, "ENV_DECRYPT_FAILED", "Project variables could not be decrypted", {
      hint: `${errors.join(", ")}. Check KI00_ENCRYPTION_KEY; values encrypted with a different key cannot be used.`,
    });
  }
  if (Object.keys(variables).length === 0) return;
  await client.setTriggerEnvironmentVariables(triggerUuid, variables);
}

export async function runtimeEnvForProject(
  env: Env,
  projectId: string
): Promise<{ values: Record<string, string>; errors: string[] }> {
  const rows = await dbAll<{ key: string; value_enc: string; use_runtime: number }>(
    env.DB,
    "SELECT key, value_enc, use_runtime FROM env_vars WHERE project_id = ? AND scope = 'production'",
    projectId
  );
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const row of rows) {
    if (!row.use_runtime) continue;
    try {
      values[row.key] = await decryptValue(row.value_enc, env.KI00_ENCRYPTION_KEY);
    } catch {
      errors.push(`Could not decrypt ${row.key}`);
    }
  }
  return { values, errors };
}

export async function applyRuntimeSecrets(
  env: Env,
  project: ProjectRow
): Promise<{ ok: boolean; error: string | null }> {
  if (project.runtime_kind !== "worker") return { ok: true, error: null };
  const { values, errors } = await runtimeEnvForProject(env, project.id);
  if (errors.length > 0) {
    return { ok: false, error: `${errors.join(", ")}. Runtime variables were not fully applied.` };
  }
  if (Object.keys(values).length === 0) return { ok: true, error: null };
  try {
    const { client } = await clientForWorkspace(env, project.workspace_id);
    const entries = Object.entries(values);
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = Object.fromEntries(entries.slice(i, i + 100));
      await client.putWorkerSecrets(project.worker_name, chunk);
    }
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Runtime variables could not be applied: ${error.message}`
          : "Runtime variables could not be applied",
    };
  }
}

export interface StartDeploymentInput {
  branch?: string;
  commitSha?: string;
  triggerKind?: "production" | "preview";
  rollbackOf?: string | null;
  requestedBy: string;
  acknowledgeRepoConfig?: boolean;
}

export async function startDeployment(
  env: Env,
  project: ProjectRow,
  input: StartDeploymentInput
): Promise<string> {
  if (project.wrangler_has_routes && !input.acknowledgeRepoConfig) {
    throw new ApiError(
      409,
      "REPO_CONFIG_ACK_REQUIRED",
      "This project's Wrangler config declares routes or custom domains",
      {
        hint: "Confirm that Cloudflare may attach those routes during deploy, then retry with acknowledgeRepoConfig=true.",
      }
    );
  }

  const triggerKind = input.triggerKind ?? "production";
  const branch = input.branch ?? project.branch;
  if (triggerKind === "preview" && branch === project.branch) {
    throw new ApiError(
      400,
      "PREVIEW_BRANCH_REQUIRED",
      "Preview deployments must use a branch other than the production branch"
    );
  }

  const deploymentId = newId("dep");
  const ts = now();
  await dbRun(
    env.DB,
    `INSERT INTO deployments (
      id, workspace_id, project_id, provider, trigger_kind, status, branch, commit_sha,
      rollback_of, requested_by, created_at, updated_at
    ) VALUES (?, ?, ?, 'cloudflare_workers_builds', ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    deploymentId,
    project.workspace_id,
    project.id,
    triggerKind,
    branch,
    input.commitSha ?? null,
    input.rollbackOf ?? null,
    input.requestedBy,
    ts,
    ts
  );

  try {
    const resources = await ensureDeploymentResources(env, project);
    const triggerUuid =
      triggerKind === "preview"
        ? resources.previewTriggerUuid
        : resources.productionTriggerUuid;
    if (!triggerUuid) {
      throw new ApiError(
        409,
        "PREVIEW_TRIGGER_UNAVAILABLE",
        "This project does not have a preview build trigger",
        { hint: "Cloudflare allows at most two build triggers per Worker. Check the trigger list in Cloudflare." }
      );
    }

    const build = await resources.client.triggerBuild(triggerUuid, {
      branch,
      ...(input.commitSha ? { commitHash: input.commitSha } : {}),
    });
    if (!build.build_uuid) {
      throw new ApiError(502, "BUILD_NOT_ACCEPTED", "Cloudflare did not return a build id", {
        hint: "The trigger was created but the build was not queued. Retry from the dashboard.",
      });
    }
    await dbRun(
      env.DB,
      `UPDATE deployments SET build_uuid = ?, status = ?, started_at = ?, updated_at = ?
       WHERE id = ?`,
      build.build_uuid,
      mapBuildStatus(build),
      ts,
      now(),
      deploymentId
    );
    await dbRun(
      env.DB,
      "UPDATE projects SET status = 'deploying', last_deployment_id = ?, updated_at = ? WHERE id = ?",
      deploymentId,
      now(),
      project.id
    );
    await recordActivity(env.DB, {
      workspaceId: project.workspace_id,
      projectId: project.id,
      type: "deploy.started",
      level: "info",
      message: `Deployment queued for ${project.name} on ${branch}`,
      meta: { deploymentId, buildUuid: build.build_uuid, triggerKind },
      actor: input.requestedBy,
    });
    return deploymentId;
  } catch (error) {
    const message =
      error instanceof ApiError
        ? `${error.message}${error.hint ? ` — ${error.hint}` : ""}`
        : error instanceof Error
          ? error.message
          : "Deployment could not be started";
    await dbRun(
      env.DB,
      `UPDATE deployments SET status = 'failed', outcome = 'fail', error_summary = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      truncate(message, 1000),
      now(),
      now(),
      deploymentId
    );
    await dbRun(
      env.DB,
      "UPDATE projects SET status = 'active', last_build_status = 'failed', updated_at = ? WHERE id = ?",
      now(),
      project.id
    );
    await recordActivity(env.DB, {
      workspaceId: project.workspace_id,
      projectId: project.id,
      type: "deploy.error",
      level: "error",
      message: `Could not start deployment for ${project.name}: ${truncate(message, 300)}`,
      meta: { deploymentId },
      actor: input.requestedBy,
    });
    throw error;
  }
}

export function mapBuildStatus(build: CloudflareBuild): DeploymentStatus {
  const outcome = (build.build_outcome ?? "").toLowerCase();
  if (outcome === "success") return "success";
  if (outcome === "fail") return "failed";
  if (outcome === "cancelled" || outcome === "terminated") return "cancelled";
  if (outcome === "skipped") return "skipped";
  const status = (build.status ?? "").toLowerCase();
  if (status === "queued") return "queued";
  if (status === "initializing") return "initializing";
  if (status === "running") return "running";
  if (status === "stopped") return outcome === "success" ? "success" : "unknown";
  return "unknown";
}

function parseTimestamp(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface SyncResult {
  status: DeploymentStatus;
  changed: boolean;
  deploymentId: string;
}

export async function syncDeployment(
  env: Env,
  deploymentId: string,
  workspaceId: string
): Promise<SyncResult> {
  const row = await dbFirst<Record<string, any>>(
    env.DB,
    `SELECT d.id AS deployment_id, d.workspace_id, d.project_id, d.build_uuid,
            d.status AS deployment_status, d.created_at, d.started_at, d.url, d.error_summary,
            p.name, p.custom_url, p.workers_dev_url
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE d.id = ? AND d.workspace_id = ?`,
    deploymentId,
    workspaceId
  );
  if (!row) throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "Deployment not found");
  const previous = row.deployment_status as DeploymentStatus;
  if (previous === "success" || previous === "failed" || previous === "cancelled" || previous === "skipped") {
    return { status: previous, changed: false, deploymentId };
  }
  if (!row.build_uuid) {
    const created = Number(row.created_at ?? 0);
    if (created && now() - created > 10 * 60 * 1000) {
      await dbRun(
        env.DB,
        `UPDATE deployments SET status = 'failed', outcome = 'fail', error_summary = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
        "Cloudflare never accepted this build. No deployment was created.",
        now(),
        now(),
        deploymentId
      );
      return { status: "failed", changed: true, deploymentId };
    }
    return { status: previous, changed: false, deploymentId };
  }

  const { client } = await clientForWorkspace(env, row.workspace_id);
  let build: CloudflareBuild;
  try {
    build = await client.getBuild(row.build_uuid);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) {
      await dbRun(
        env.DB,
        `UPDATE deployments SET status = 'unknown', error_summary = ?, updated_at = ? WHERE id = ?`,
        "Cloudflare no longer reports this build. It may have been deleted.",
        now(),
        deploymentId
      );
      return { status: "unknown", changed: true, deploymentId };
    }
    throw error;
  }

  const status = mapBuildStatus(build);
  const started =
    parseTimestamp(build.initializing_on) ??
    parseTimestamp(build.running_on) ??
    parseTimestamp(build.created_on) ??
    (Number(row.started_at ?? 0) || null);
  const finished =
    parseTimestamp(build.stopped_on) ??
    (status === "success" || status === "failed" || status === "cancelled" || status === "skipped"
      ? parseTimestamp(build.modified_on) ?? now()
      : null);
  const duration = started && finished ? Math.max(0, finished - started) : null;
  const terminal = status === "success" || status === "failed" || status === "cancelled" || status === "skipped";
  const url = status === "success" ? row.custom_url ?? row.workers_dev_url ?? null : row.url ?? null;

  let errorSummary = row.error_summary ?? null;
  if (status === "failed" && row.build_uuid) {
    errorSummary = await summarizeFailure(env, row, row.build_uuid);
  }

  await dbRun(
    env.DB,
    `UPDATE deployments SET status = ?, outcome = ?, commit_sha = COALESCE(?, commit_sha),
     commit_message = COALESCE(?, commit_message), author = COALESCE(?, author),
     preview_url = COALESCE(?, preview_url), started_at = COALESCE(?, started_at),
     finished_at = ?, duration_ms = COALESCE(?, duration_ms), error_summary = ?, url = ?,
     updated_at = ? WHERE id = ?`,
    status,
    build.build_outcome ?? (status === "success" ? "success" : status === "failed" ? "fail" : null),
    build.build_trigger_metadata?.commit_hash ?? null,
    build.build_trigger_metadata?.commit_message ?? null,
    build.build_trigger_metadata?.author ?? null,
    build.preview_url ?? null,
    started,
    finished,
    duration,
    errorSummary,
    url,
    now(),
    deploymentId
  );

  const projectRow = await dbFirst<ProjectRow>(
    env.DB,
    "SELECT * FROM projects WHERE id = ?",
    row.project_id
  );

  if (terminal) {
    if (projectRow) {
      await dbRun(
        env.DB,
        `UPDATE projects SET status = 'active', last_build_status = ?,
         last_build_finished_at = ?, last_deployed_at = CASE WHEN ? = 'success' THEN ? ELSE last_deployed_at END,
         updated_at = ? WHERE id = ?`,
        status === "success" ? "success" : status === "failed" ? "failed" : status,
        finished,
        status,
        finished,
        now(),
        projectRow.id
      );
    }
    if (status === "success") {
      const runtime = projectRow
        ? await applyRuntimeSecrets(env, projectRow)
        : { ok: false, error: "Project record was missing, so runtime secrets were not applied." };
      await recordActivity(env.DB, {
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        type: "deploy.success",
        level: "success",
        message: `${row.name} deployed successfully${build.build_trigger_metadata?.commit_hash ? ` from commit ${String(build.build_trigger_metadata.commit_hash).slice(0, 7)}` : ""}`,
        meta: { deploymentId, url, runtimeVariablesApplied: runtime.ok },
        actor: build.build_trigger_metadata?.author ?? null,
      });
      if (!runtime.ok) {
        await recordActivity(env.DB, {
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          type: "env.runtime_failed",
          level: "warn",
          message: runtime.error ?? "Runtime variables could not be applied",
          meta: { deploymentId },
          actor: null,
        });
      }
    } else if (status === "failed") {
      await recordActivity(env.DB, {
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        type: "deploy.failed",
        level: "error",
        message: `${row.name} deployment failed${errorSummary ? `: ${truncate(errorSummary, 240)}` : ""}`,
        meta: { deploymentId, buildUuid: row.build_uuid },
        actor: build.build_trigger_metadata?.author ?? null,
      });
    } else {
      await recordActivity(env.DB, {
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        type: "deploy.cancelled",
        level: "warn",
        message: `${row.name} deployment ${status}`,
        meta: { deploymentId },
        actor: null,
      });
    }
    await setSetting(env.DB, `workspace:${row.workspace_id}:last-sync`, String(now()));
  }

  return { status, changed: previous !== status, deploymentId };
}

async function summarizeFailure(env: Env, row: Record<string, any>, buildUuid: string): Promise<string> {
  try {
    const { client } = await clientForWorkspace(env, row.workspace_id);
    const logs = await client.getBuildLogs(buildUuid);
    const parsed = parseCloudflareLogLines(logs.lines ?? []);
    const secrets = await projectSecretsForRedaction(env, row.project_id);
    const errorLines = parsed
      .filter((line) => line.level === "error" || /error|failed|exited with code/i.test(line.text))
      .slice(-8)
      .map((line) => line.text);
    const tail = (errorLines.length ? errorLines : parsed.slice(-6).map((line) => line.text)).join("\n");
    return truncate(redactSecrets(tail || "Cloudflare reported a failed build.", secrets), 1500);
  } catch {
    return "Cloudflare reported a failed build. Open the build logs for details.";
  }
}

export async function fetchDeploymentLogs(
  env: Env,
  deploymentId: string,
  workspaceId: string,
  options: { force?: boolean } = {}
): Promise<{
  lines: LogLine[];
  source: "cloudflare" | "cache" | "unavailable" | "demo";
  truncated: boolean;
  error: string | null;
  deployment: Record<string, any>;
}> {
  const deployment = await dbFirst<Record<string, any>>(
    env.DB,
    `SELECT d.*, p.name AS project_name, p.runtime_kind
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE d.id = ? AND d.workspace_id = ?`,
    deploymentId,
    workspaceId
  );
  if (!deployment) throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "Deployment not found");

  if (deployment.provider === "demo") {
    return {
      lines: [],
      source: "demo",
      truncated: false,
      error: "Demo workspace: build logs are only available from real Cloudflare builds.",
      deployment,
    };
  }

  const cached = await readCachedLogs(env.DB, deploymentId);
  const terminal = ["success", "failed", "cancelled", "skipped"].includes(String(deployment.status));
  const cacheFresh =
    deployment.logs_cached_at && now() - Number(deployment.logs_cached_at) < (terminal ? 10 * 60 * 1000 : 15 * 1000);

  if (!options.force && cacheFresh && cached.length > 0) {
    return { lines: cached, source: "cache", truncated: false, error: null, deployment };
  }
  if (!deployment.build_uuid) {
    return {
      lines: cached,
      source: cached.length ? "cache" : "unavailable",
      truncated: false,
      error: cached.length ? null : "This deployment has no Cloudflare build id yet.",
      deployment,
    };
  }

  try {
    const { client } = await clientForWorkspace(env, deployment.workspace_id);
    const collected: (string | number)[][] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < 10; page++) {
      const result = await client.getBuildLogs(deployment.build_uuid, cursor);
      collected.push(...(result.lines ?? []));
      truncated = Boolean(result.truncated);
      if (!result.cursor || (result.lines ?? []).length === 0) break;
      cursor = result.cursor;
      if (collected.length > 4000) {
        truncated = true;
        break;
      }
    }
    const secrets = await projectSecretsForRedaction(env, deployment.project_id);
    const parsed = parseCloudflareLogLines(collected).map((line) => ({
      ...line,
      text: redactSecrets(line.text, secrets),
    }));
    if (parsed.length > 0 && terminal) {
      await writeCachedLogs(env.DB, deploymentId, parsed);
    }
    return { lines: parsed, source: "cloudflare", truncated, error: null, deployment };
  } catch (error) {
    return {
      lines: cached,
      source: cached.length ? "cache" : "unavailable",
      truncated: false,
      error:
        error instanceof Error
          ? `Could not load build logs from Cloudflare: ${error.message}`
          : "Could not load build logs from Cloudflare",
      deployment,
    };
  }
}

export function parseCloudflareLogLines(lines: (string | number)[][]): LogLine[] {
  const out: LogLine[] = [];
  for (const row of lines) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const numbers = row.filter((value): value is number => typeof value === "number");
    const strings = row.filter((value): value is string => typeof value === "string" && value.length > 0);
    if (strings.length === 0) continue;
    const timestamp = numbers.find((value) => value > 1_000_000_000_000) ?? numbers.find((value) => value > 1_000_000_000);
    const ts =
      timestamp === undefined
        ? null
        : timestamp > 10_000_000_000
          ? timestamp
          : timestamp * 1000;
    let text = strings.join(" ");
    let level: LogLine["level"] = "info";
    if (/^\s*\{/.test(text)) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        text =
          typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.msg === "string"
              ? parsed.msg
              : text;
        const rawLevel = String(parsed.level ?? parsed.severity ?? "").toLowerCase();
        if (rawLevel === "error" || rawLevel === "warn" || rawLevel === "debug") {
          level = rawLevel as LogLine["level"];
        }
      } catch {
        /* plain text that starts with a brace */
      }
    }
    if (level === "info") {
      if (/\b(error|failed|failure|exited with code [1-9])\b/i.test(text)) level = "error";
      else if (/\bwarn(ing)?\b/i.test(text)) level = "warn";
      else if (/\bdebug\b/i.test(text)) level = "debug";
      else if (/^(KI00|Cloning|Installing|Build|Deploy|Success|Detected)/i.test(text) && !/[✖❌]/u.test(text)) {
        level = "system";
      }
    }
    out.push({ ts, level, text: truncate(text, 4000) });
  }
  return out;
}

async function projectSecretsForRedaction(env: Env, projectId: string): Promise<string[]> {
  const secrets = [env.CLOUDFLARE_API_TOKEN, env.GITHUB_TOKEN, env.OPENROUTER_API_KEY, env.KI00_ENCRYPTION_KEY].filter(
    (value): value is string => Boolean(value && value.length >= 6)
  );
  const rows = await dbAll<{ value_enc: string; is_secret: number }>(
    env.DB,
    "SELECT value_enc, is_secret FROM env_vars WHERE project_id = ? AND is_secret = 1",
    projectId
  );
  for (const row of rows) {
    try {
      secrets.push(await decryptValue(row.value_enc, env.KI00_ENCRYPTION_KEY));
    } catch {
      /* undecryptable values are skipped */
    }
  }
  return secrets;
}

async function readCachedLogs(db: D1Database, deploymentId: string): Promise<LogLine[]> {
  const rows = await dbAll<{ content: string }>(
    db,
    "SELECT content FROM deployment_logs WHERE deployment_id = ? ORDER BY chunk ASC",
    deploymentId
  );
  const lines: LogLine[] = [];
  for (const row of rows) {
    try {
      lines.push(...(JSON.parse(row.content) as LogLine[]));
    } catch {
      /* ignore corrupt chunk */
    }
  }
  return lines;
}

async function writeCachedLogs(db: D1Database, deploymentId: string, lines: LogLine[]): Promise<void> {
  const capped = lines.slice(-2500);
  const chunks: LogLine[][] = [];
  for (let i = 0; i < capped.length; i += 250) chunks.push(capped.slice(i, i + 250));
  await dbRun(db, "DELETE FROM deployment_logs WHERE deployment_id = ?", deploymentId);
  let bytes = 0;
  for (let index = 0; index < chunks.length; index++) {
    const content = JSON.stringify(chunks[index]);
    if (bytes + content.length > 500_000) break;
    bytes += content.length;
    await dbRun(
      db,
      "INSERT INTO deployment_logs (deployment_id, chunk, content, created_at) VALUES (?, ?, ?, ?)",
      deploymentId,
      index,
      content,
      now()
    );
  }
  await dbRun(
    db,
    "UPDATE deployments SET logs_cached_at = ?, logs_bytes = ?, updated_at = ? WHERE id = ?",
    now(),
    bytes,
    now(),
    deploymentId
  );
}

export async function cancelDeployment(
  env: Env,
  deploymentId: string,
  workspaceId: string
): Promise<void> {
  const row = await dbFirst<Record<string, any>>(
    env.DB,
    "SELECT * FROM deployments WHERE id = ? AND workspace_id = ?",
    deploymentId,
    workspaceId
  );
  if (!row) throw new ApiError(404, "DEPLOYMENT_NOT_FOUND", "Deployment not found");
  if (!row.build_uuid) throw new ApiError(409, "NO_BUILD", "This deployment has no running build");
  if (["success", "failed", "cancelled", "skipped"].includes(row.status)) {
    throw new ApiError(409, "BUILD_FINISHED", "This build has already finished");
  }
  const { client } = await clientForWorkspace(env, row.workspace_id);
  await client.cancelBuild(row.build_uuid);
  await dbRun(
    env.DB,
    "UPDATE deployments SET status = 'cancelled', outcome = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?",
    now(),
    now(),
    deploymentId
  );
  await recordActivity(env.DB, {
    workspaceId,
    projectId: row.project_id,
    type: "deploy.cancelled",
    level: "warn",
    message: "Deployment cancelled by user",
    meta: { deploymentId },
    actor: null,
  });
}

export async function syncActiveDeployments(
  env: Env,
  workspaceId: string,
  limit = 5,
  projectId?: string
): Promise<number> {
  const active = projectId
    ? await dbAll<{ id: string }>(
        env.DB,
        `SELECT id FROM deployments WHERE workspace_id = ? AND project_id = ? AND status IN ('queued','initializing','running')
         ORDER BY created_at ASC LIMIT ?`,
        workspaceId,
        projectId,
        limit
      )
    : await dbAll<{ id: string }>(
        env.DB,
        `SELECT id FROM deployments WHERE workspace_id = ? AND status IN ('queued','initializing','running')
         ORDER BY created_at ASC LIMIT ?`,
        workspaceId,
        limit
      );
  let changed = 0;
  for (const row of active) {
    try {
      const result = await syncDeployment(env, row.id, workspaceId);
      if (result.changed) changed++;
    } catch {
      /* Provider hiccups should not fail the whole dashboard sync. */
    }
  }
  if (active.length > 0) {
    await setSetting(env.DB, `workspace:${workspaceId}:last-sync`, String(now()));
  }
  return changed;
}

/** Pushes build-time variables to existing triggers without creating resources. */
export async function pushBuildEnvironment(env: Env, project: ProjectRow): Promise<{ ok: boolean; error: string | null }> {
  if (!project.production_trigger_uuid && !project.preview_trigger_uuid) {
    return { ok: true, error: null };
  }
  try {
    const { client } = await clientForWorkspace(env, project.workspace_id);
    if (project.production_trigger_uuid) {
      await applyBuildEnvironment(env, project, client, project.production_trigger_uuid, "production");
    }
    if (project.preview_trigger_uuid) {
      await applyBuildEnvironment(env, project, client, project.preview_trigger_uuid, "preview");
    }
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Saved, but the build environment was not pushed to Cloudflare: ${error.message}`
          : "Saved, but the build environment was not pushed to Cloudflare",
    };
  }
}
