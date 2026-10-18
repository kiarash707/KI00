import type {
  Activity,
  Deployment,
  DeploymentStatus,
  DomainRecord,
  EnvVar,
  Project,
  RuntimeKind,
  CompatibilityStatus,
  BuildOutcome,
} from "../../shared/types";
import { bool, json, now } from "./utils";

type DbRow = Record<string, unknown>;

export function mapProject(row: DbRow): Project {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description ?? ""),
    repoOwner: String(row.repo_owner),
    repoName: String(row.repo_name),
    repoFullName: `${row.repo_owner}/${row.repo_name}`,
    repoId: row.repo_id ? String(row.repo_id) : null,
    repoPrivate: bool(row.repo_private),
    repoUrl: `https://github.com/${row.repo_owner}/${row.repo_name}`,
    defaultBranch: String(row.default_branch ?? "main"),
    branch: String(row.branch ?? "main"),
    projectType: String(row.project_type ?? "static"),
    framework: row.framework ? String(row.framework) : null,
    language: row.language ? String(row.language) : null,
    runtimeKind: String(row.runtime_kind ?? "unknown") as RuntimeKind,
    runtimeDetail: row.runtime_detail ? String(row.runtime_detail) : null,
    compatibilityStatus: String(row.compatibility_status ?? "unknown") as CompatibilityStatus,
    compatibilityNotes: json<string[]>(row.compatibility_notes as string | null, []),
    buildCommand: String(row.build_command ?? ""),
    installCommand: String(row.install_command ?? ""),
    outputDir: String(row.output_dir ?? "dist"),
    rootDir: String(row.root_dir ?? "/"),
    deployCommand: String(row.deploy_command ?? ""),
    workerName: String(row.worker_name),
    workerTag: row.worker_tag ? String(row.worker_tag) : null,
    url: row.custom_url
      ? String(row.custom_url)
      : row.workers_dev_url
        ? String(row.workers_dev_url)
        : null,
    customUrl: row.custom_url ? String(row.custom_url) : null,
    spaFallback: bool(row.spa_fallback),
    autoDeploy: bool(row.auto_deploy),
    buildCaching: bool(row.build_caching),
    status: String(row.status ?? "active") as Project["status"],
    detectedEnvKeys: json<string[]>(row.detected_env_keys as string | null, []),
    lastBuildStatus: row.last_build_status ? String(row.last_build_status) : null,
    lastBuildFinishedAt: row.last_build_finished_at ? Number(row.last_build_finished_at) : null,
    lastDeployedAt: row.last_deployed_at ? Number(row.last_deployed_at) : null,
    lastDeploymentId: row.last_deployment_id ? String(row.last_deployment_id) : null,
    createdAt: Number(row.created_at ?? now()),
    updatedAt: Number(row.updated_at ?? now()),
  };
}

export function mapDeployment(row: DbRow, project?: { name: string; slug: string } | null): Deployment {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectName: project?.name ?? (row.project_name ? String(row.project_name) : undefined),
    projectSlug: project?.slug ?? (row.project_slug ? String(row.project_slug) : undefined),
    provider: String(row.provider ?? "cloudflare_workers_builds"),
    triggerKind: String(row.trigger_kind ?? "production") as "production" | "preview",
    buildUuid: row.build_uuid ? String(row.build_uuid) : null,
    status: String(row.status ?? "queued") as DeploymentStatus,
    outcome: row.outcome ? (String(row.outcome) as BuildOutcome) : null,
    branch: String(row.branch ?? "main"),
    commitSha: row.commit_sha ? String(row.commit_sha) : null,
    commitMessage: row.commit_message ? String(row.commit_message) : null,
    author: row.author ? String(row.author) : null,
    url: row.url ? String(row.url) : null,
    previewUrl: row.preview_url ? String(row.preview_url) : null,
    errorSummary: row.error_summary ? String(row.error_summary) : null,
    rollbackOf: row.rollback_of ? String(row.rollback_of) : null,
    createdAt: Number(row.created_at ?? now()),
    startedAt: row.started_at ? Number(row.started_at) : null,
    finishedAt: row.finished_at ? Number(row.finished_at) : null,
    durationMs: row.duration_ms ? Number(row.duration_ms) : null,
    updatedAt: Number(row.updated_at ?? now()),
    logsCachedAt: row.logs_cached_at ? Number(row.logs_cached_at) : null,
    logsBytes: Number(row.logs_bytes ?? 0),
  };
}

export function mapEnvVar(row: DbRow): EnvVar {
  return {
    id: String(row.id),
    key: String(row.key),
    maskedValue: String(row.masked_value ?? ""),
    isSecret: bool(row.is_secret),
    scope: String(row.scope) as "production" | "preview",
    useBuild: bool(row.use_build),
    useRuntime: bool(row.use_runtime),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapDomain(row: DbRow): DomainRecord {
  return {
    id: String(row.id),
    hostname: String(row.hostname),
    zoneId: row.zone_id ? String(row.zone_id) : null,
    zoneName: row.zone_name ? String(row.zone_name) : null,
    status: String(row.status ?? "pending") as DomainRecord["status"],
    dnsInstructions: row.dns_instructions ? String(row.dns_instructions) : null,
    error: row.error ? String(row.error) : null,
    createdAt: Number(row.created_at),
    verifiedAt: row.verified_at ? Number(row.verified_at) : null,
  };
}

export function mapActivity(row: DbRow): Activity {
  return {
    id: String(row.id),
    type: String(row.type),
    level: String(row.level ?? "info") as Activity["level"],
    message: String(row.message),
    projectId: row.project_id ? String(row.project_id) : null,
    projectName: row.project_name ? String(row.project_name) : null,
    actor: row.actor ? String(row.actor) : null,
    createdAt: Number(row.created_at),
  };
}
