/**
 * Shared API types for the KI00 Worker and dashboard.
 * These are transport contracts only — no secrets ever appear here.
 */

export type RuntimeKind = "static" | "worker" | "container" | "unsupported" | "unknown";
export type CompatibilityStatus = "compatible" | "needs_adapter" | "incompatible" | "unknown";
export type ProjectStatus = "active" | "deploying" | "error" | "archived";

export type DeploymentStatus =
  | "queued"
  | "initializing"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "skipped"
  | "unknown";

export type BuildOutcome = "success" | "fail" | "skipped" | "cancelled" | "terminated";

export const TERMINAL_DEPLOYMENT_STATUSES: DeploymentStatus[] = [
  "success",
  "failed",
  "cancelled",
  "skipped",
];

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    hint?: string;
  };
}

export interface ProviderStatus {
  configured: boolean;
  ok: boolean | null;
  identity?: string | null;
  detail?: string | null;
  error?: string | null;
  errorHint?: string | null;
  checkedAt?: number | null;
}

export interface Capabilities {
  setupComplete: boolean;
  demo: boolean;
  env: string;
  version: string;
  providers: {
    cloudflare: ProviderStatus & {
      accountId?: string | null;
      accountName?: string | null;
      workersSubdomain?: string | null;
      buildToken?: "configured" | "missing" | "unknown";
    };
    github: ProviderStatus & { login?: string | null; scopes?: string | null; mode: "token" | "public" };
    openrouter: ProviderStatus & { freeModels?: number | null; selectedModel?: string | null };
    encryption: { configured: boolean };
    setup: { tokenConfigured: boolean };
  };
  limits: { agentModelCallsPerRun: number; agentRunsPerHour: number; deploysPerHour: number };
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  cloudflareAccountId: string | null;
  cloudflareAccountName: string | null;
  role: string;
  createdAt: number;
}

export interface SessionInfo {
  authenticated: boolean;
  user: User | null;
  workspace: Workspace | null;
  workspaces: Workspace[];
  csrfToken: string | null;
  capabilities: Capabilities;
  expired?: boolean;
}

export interface RepoSummary {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  updatedAt: string | null;
  htmlUrl: string;
  archived: boolean;
}

export interface BranchSummary {
  name: string;
  protected: boolean;
  sha: string;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size: number | null;
}

export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  date: string | null;
}

export interface DetectionResult {
  framework: string;
  language: string;
  projectType: string;
  runtimeKind: RuntimeKind;
  runtimeDetail: string;
  buildCommand: string;
  installCommand: string;
  outputDir: string;
  rootDir: string;
  spaFallback: boolean;
  compatibilityStatus: CompatibilityStatus;
  compatibilityNotes: string[];
  blockers: string[];
  migrationOptions: string[];
  evidence: string[];
  requiredEnvKeys: string[];
  configFiles: string[];
  hasDockerfile: boolean;
  hasWrangler: boolean;
  hasPackageJson: boolean;
  suggestedName: string;
  confidence: "high" | "medium" | "low";
}

export interface RepoAnalysis {
  repo: RepoSummary;
  branch: string;
  commit: CommitSummary | null;
  tree: TreeEntry[];
  treeTruncated: boolean;
  fileCount: number;
  detection: DetectionResult;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none";
  warnings: string[];
  analyzedAt: number;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  repoId: string | null;
  repoPrivate: boolean;
  repoUrl: string;
  defaultBranch: string;
  branch: string;
  projectType: string;
  framework: string | null;
  language: string | null;
  runtimeKind: RuntimeKind;
  runtimeDetail: string | null;
  compatibilityStatus: CompatibilityStatus;
  compatibilityNotes: string[];
  buildCommand: string;
  installCommand: string;
  outputDir: string;
  rootDir: string;
  deployCommand: string;
  workerName: string;
  workerTag: string | null;
  url: string | null;
  customUrl: string | null;
  spaFallback: boolean;
  autoDeploy: boolean;
  buildCaching: boolean;
  status: ProjectStatus;
  detectedEnvKeys: string[];
  lastBuildStatus: string | null;
  lastBuildFinishedAt: number | null;
  lastDeployedAt: number | null;
  lastDeploymentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Deployment {
  id: string;
  projectId: string;
  projectName?: string;
  projectSlug?: string;
  provider: string;
  triggerKind: "production" | "preview";
  buildUuid: string | null;
  status: DeploymentStatus;
  outcome: BuildOutcome | null;
  branch: string;
  commitSha: string | null;
  commitMessage: string | null;
  author: string | null;
  url: string | null;
  previewUrl: string | null;
  errorSummary: string | null;
  rollbackOf: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  updatedAt: number;
  logsCachedAt: number | null;
  logsBytes: number;
}

export interface DeploymentDetail extends Deployment {
  project: Project;
  logs: LogLine[];
  logsSource: "cloudflare" | "cache" | "unavailable" | "demo";
  logsTruncated: boolean;
  logsError: string | null;
}

export interface LogLine {
  ts: number | null;
  level: "info" | "warn" | "error" | "debug" | "system";
  text: string;
}

export interface EnvVar {
  id: string;
  key: string;
  maskedValue: string;
  isSecret: boolean;
  scope: "production" | "preview";
  useBuild: boolean;
  useRuntime: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DomainRecord {
  id: string;
  hostname: string;
  zoneId: string | null;
  zoneName: string | null;
  status: "pending" | "active" | "error" | "instructions";
  dnsInstructions: string | null;
  error: string | null;
  createdAt: number;
  verifiedAt: number | null;
}

export interface Activity {
  id: string;
  type: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
  projectId: string | null;
  projectName?: string | null;
  actor: string | null;
  createdAt: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  createdAt: number;
  meta?: Record<string, unknown> | null;
}

export interface QuotaInfo {
  name: string;
  used: number | null;
  limit: number | null;
  unit: string;
  source: "cloudflare_api" | "cloudflare_docs" | "local";
  note?: string;
  docsUrl?: string;
}

export interface OverviewStats {
  projects: number;
  deployments: number;
  successful: number;
  failed: number;
  building: number;
  successRate: number | null;
  last7d: number;
  last7dFailed: number;
  sparkline: { day: string; success: number; failed: number }[];
}

export interface Overview {
  workspace: Workspace;
  stats: OverviewStats;
  resources: {
    cloudflare: Capabilities["providers"]["cloudflare"] & {
      consoleUrl: string;
      workerCount: number | null;
      buildMinutes: { remaining: number | null; limit: number | null; error: string | null };
      subdomain: string | null;
    };
    github: Capabilities["providers"]["github"] & {
      rateLimit: { limit: number | null; remaining: number | null; resetAt: number | null };
    };
    openrouter: Capabilities["providers"]["openrouter"];
    storage: { database: string; deployments: number; logBytes: number; envVars: number; domains: number };
  };
  quotas: QuotaInfo[];
  recentDeployments: Deployment[];
  activities: Activity[];
  errors: Activity[];
  lastSyncAt: number | null;
  demo: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export interface FreeModel {
  id: string;
  name: string;
  contextLength: number;
  maxCompletionTokens: number | null;
  supportsTools: boolean;
  promptPrice: string;
  completionPrice: string;
  created: number;
  score: number;
  reasons: string[];
  modality: string | null;
}

export interface ModelCatalog {
  models: FreeModel[];
  selectedModel: string | null;
  selectedModelName: string | null;
  selectionReason: string | null;
  fetchedAt: number | null;
  stale: boolean;
  error: string | null;
  overridden: boolean;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "approval";
  content: string;
  toolName: string | null;
  toolArgs: unknown;
  toolResult: unknown;
  model: string | null;
  createdAt: number;
}

export interface AgentThread {
  id: string;
  title: string;
  projectId: string | null;
  projectName?: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
}

export interface AgentThreadDetail extends AgentThread {
  messages: AgentMessage[];
}

export interface Approval {
  id: string;
  action: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  projectId: string | null;
  threadId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface AgentRunInfo {
  id: string;
  status: "running" | "completed" | "failed" | "stopped" | "awaiting_approval";
  model: string | null;
  calls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface CreateProjectInput {
  name: string;
  repoOwner: string;
  repoName: string;
  repoId?: string | null;
  branch: string;
  description?: string;
  installCommand: string;
  buildCommand: string;
  outputDir: string;
  rootDir: string;
  deployCommand?: string;
  framework: string;
  language: string;
  projectType: string;
  runtimeKind: RuntimeKind;
  runtimeDetail: string;
  compatibilityStatus: CompatibilityStatus;
  compatibilityNotes?: string[];
  spaFallback: boolean;
  autoDeploy: boolean;
  detectedEnvKeys?: string[];
}

export interface UpdateProjectInput {
  name?: string;
  branch?: string;
  description?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDir?: string;
  rootDir?: string;
  autoDeploy?: boolean;
  buildCaching?: boolean;
  spaFallback?: boolean;
}

export const DEPLOYMENT_STATUS_LABELS: Record<DeploymentStatus, string> = {
  queued: "Queued",
  initializing: "Initializing",
  running: "Building",
  success: "Deployed",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  unknown: "Unknown",
};

export const RUNTIME_LABELS: Record<RuntimeKind, string> = {
  static: "Static Assets",
  worker: "Workers",
  container: "Container",
  unsupported: "Unsupported",
  unknown: "Unknown",
};

export const COMPATIBILITY_LABELS: Record<CompatibilityStatus, string> = {
  compatible: "Compatible",
  needs_adapter: "Adapter required",
  incompatible: "Incompatible",
  unknown: "Unknown",
};

export interface DeploymentWithProject extends Deployment {
  project: Project;
}

export interface RuntimeLogsResponse {
  lines: LogLine[];
  available: boolean;
  error: string | null;
  projectId: string;
  workerName: string;
  windowMinutes: number;
}

export interface SearchResult {
  projects: Project[];
  deployments: Deployment[];
  pages: { label: string; path: string; description: string }[];
}

export interface ConnectionsInfo {
  capabilities: Capabilities;
  cloudflare: {
    accountName: string | null;
    accountId: string | null;
    workersSubdomain: string | null;
    zones: { id: string; name: string; status: string }[];
    workerCount: number | null;
    buildMinutes: { remaining: number | null; limit: number | null; error: string | null };
    buildToken: "configured" | "missing" | "unknown";
    permissionHint: string;
    docsUrl: string;
  };
  github: {
    mode: "token" | "public";
    login: string | null;
    rateLimit: { limit: number | null; remaining: number | null; resetAt: number | null };
    requiredScopes: string[];
    docsUrl: string;
  };
  openrouter: {
    freeModels: number;
    selectedModel: string | null;
    selectedModelName: string | null;
    keyLabel: string | null;
    usage: { usage: number | null; limit: number | null; isFreeTier: boolean | null } | null;
    docsUrl: string;
  };
  encryption: { configured: boolean };
  demo: boolean;
}

export interface SessionRecord {
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string | null;
  ipHash: string | null;
}

export type AgentEvent =
  | { type: "run_start"; runId: string; threadId: string; model: string; modelName: string }
  | { type: "model_call"; call: number; model: string }
  | { type: "message"; content: string }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary: string; result: unknown }
  | { type: "approval"; approvalId: string; action: string; args: Record<string, unknown> }
  | { type: "model_switch"; from: string; to: string; reason: string }
  | { type: "usage"; calls: number; promptTokens: number; completionTokens: number; maxCalls: number }
  | { type: "limit"; message: string }
  | { type: "done"; runId: string; status: string }
  | { type: "error"; message: string; code?: string };

export interface AgentToolCallView {
  id: string;
  name: string;
  args: string;
}
