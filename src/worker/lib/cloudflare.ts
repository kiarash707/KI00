import type { LogLine } from "../../shared/types";
import { ProviderError } from "./errors";
import { fetchWithTimeout, parseRetryAfter, sleep } from "./http";
import { newId } from "./utils";

const API_BASE = "https://api.cloudflare.com/client/v4";

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: { code?: number; message?: string }[];
  messages?: string[];
  result_info?: Record<string, unknown>;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareTokenInfo {
  id: string;
  status: string;
  not_before?: string;
  expires_on?: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  account?: { id: string; name: string };
}

export interface CloudflareWorkerScript {
  id: string;
  tag?: string;
  created_on?: string;
  modified_on?: string;
}

export interface CloudflareBuildToken {
  build_token_uuid?: string;
  build_token_name?: string;
  cloudflare_token_id?: string;
  owner_type?: string;
}

export interface CloudflareRepoConnection {
  repo_connection_uuid?: string;
  provider_type?: string;
  provider_account_id?: string;
  provider_account_name?: string;
  repo_id?: string;
  repo_name?: string;
}

export interface CloudflareBuildTrigger {
  trigger_uuid?: string;
  trigger_name?: string;
  external_script_id?: string;
  repo_connection_uuid?: string;
  build_token_uuid?: string;
  build_command?: string;
  deploy_command?: string;
  root_directory?: string;
  branch_includes?: string[];
  branch_excludes?: string[];
  path_includes?: string[];
  path_excludes?: string[];
  build_caching_enabled?: boolean;
}

export interface CloudflareBuild {
  build_uuid?: string;
  status?: string;
  build_outcome?: string;
  created_on?: string;
  initializing_on?: string;
  running_on?: string;
  stopped_on?: string;
  modified_on?: string;
  preview_url?: string;
  build_trigger_metadata?: {
    branch?: string;
    commit_hash?: string;
    commit_message?: string;
    author?: string;
    build_command?: string;
    deploy_command?: string;
    build_trigger_source?: string;
    repo_name?: string;
    provider_account_name?: string;
    root_directory?: string;
    environment_variables?: Record<string, unknown>;
  };
  trigger?: CloudflareBuildTrigger;
}

export interface CloudflareBuildLogs {
  lines: (string | number)[][];
  cursor?: string;
  truncated?: boolean;
}

export interface CloudflareDomain {
  id: string;
  hostname: string;
  zone_id?: string;
  zone_name?: string;
  service?: string;
  environment?: string;
  cert_id?: string;
  enabled?: boolean;
}

export interface BuildLimits {
  remainingMinutes: number | null;
  limitMinutes: number | null;
  raw: unknown;
}

export interface RuntimeLogQuery {
  scriptName: string;
  from: number;
  to: number;
  limit?: number;
  text?: string;
  level?: string;
}

export interface RuntimeLogResult {
  lines: LogLine[];
  available: boolean;
  error: string | null;
}

export class CloudflareClient {
  private readonly token: string;
  private readonly baseUrl: string;
  readonly accountId: string | null;

  constructor(options: { token: string; accountId?: string | null; baseUrl?: string }) {
    this.token = options.token;
    this.accountId = options.accountId ?? null;
    this.baseUrl = options.baseUrl ?? API_BASE;
  }

  static fromEnv(env: {
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
  }, accountId?: string | null): CloudflareClient {
    if (!env.CLOUDFLARE_API_TOKEN) {
      throw new ProviderError("cloudflare", 424, "Cloudflare is not connected", {
        code: "CLOUDFLARE_NOT_CONFIGURED",
        hint: "Set the CLOUDFLARE_API_TOKEN Worker secret with the permissions documented in docs/CLOUDFLARE_SETUP.md.",
      });
    }
    return new CloudflareClient({
      token: env.CLOUDFLARE_API_TOKEN,
      accountId: accountId ?? env.CLOUDFLARE_ACCOUNT_ID ?? null,
    });
  }

  private requireAccount(): string {
    if (!this.accountId) {
      throw new ProviderError("cloudflare", 400, "No Cloudflare account is selected", {
        code: "CLOUDFLARE_ACCOUNT_MISSING",
        hint: "Set CLOUDFLARE_ACCOUNT_ID, or select an account from the KI00 setup screen.",
      });
    }
    return this.accountId;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: { timeoutMs?: number; retries?: number } = {}
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const retries = options.retries ?? (method === "GET" ? 2 : 0);
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let response: Response;
      try {
        response = await fetchWithTimeout(
          `${this.baseUrl}${path}`,
          {
            ...init,
            headers: {
              Authorization: `Bearer ${this.token}`,
              "User-Agent": "KI00/0.1 (+https://github.com/kiarash707/KI00)",
              ...(init.body && !(init.body instanceof FormData)
                ? { "Content-Type": "application/json" }
                : {}),
              ...(init.headers ?? {}),
            },
          },
          options.timeoutMs ?? 20_000
        );
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new ProviderError("cloudflare", 502, "Cloudflare API is unreachable", {
          code: "CLOUDFLARE_UNREACHABLE",
          hint: error instanceof Error ? error.message : "Network error",
        });
      }

      const requestId = response.headers.get("cf-ray") ?? undefined;
      const text = await response.text();
      let payload: CloudflareEnvelope<T> | null = null;
      try {
        payload = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : null;
      } catch {
        payload = null;
      }

      if (response.ok && payload?.success !== false) {
        if (!payload) {
          throw new ProviderError("cloudflare", 502, "Cloudflare returned an unreadable response", {
            code: "CLOUDFLARE_BAD_RESPONSE",
            hint: `HTTP ${response.status} ${requestId ?? ""}`.trim(),
          });
        }
        return payload.result;
      }

      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const after = parseRetryAfter(response.headers.get("retry-after"));
        await sleep(Math.min(after ?? 600 * (attempt + 1), 4000));
        continue;
      }

      const error = payload?.errors?.[0];
      const message = error?.message ?? `Cloudflare API returned HTTP ${response.status}`;
      const code = error?.code;
      lastError = new ProviderError("cloudflare", response.status, message, {
        code: `CLOUDFLARE_${code ?? response.status}`,
        hint: hintForCloudflareError(response.status, message, code),
        details: requestId ? { requestId } : undefined,
      });
      throw lastError;
    }

    throw lastError instanceof Error
      ? lastError
      : new ProviderError("cloudflare", 502, "Cloudflare API request failed");
  }

  async verifyToken(): Promise<CloudflareTokenInfo> {
    return this.request<CloudflareTokenInfo>("/user/tokens/verify");
  }

  async listAccounts(): Promise<CloudflareAccount[]> {
    return this.request<CloudflareAccount[]>("/accounts?per_page=50");
  }

  async getWorkersSubdomain(): Promise<string | null> {
    const account = this.requireAccount();
    try {
      const result = await this.request<{ subdomain?: string }>(
        `/accounts/${account}/workers/subdomain`
      );
      return result?.subdomain ?? null;
    } catch {
      return null;
    }
  }

  async listZones(name?: string): Promise<CloudflareZone[]> {
    const query = new URLSearchParams({ per_page: "50" });
    if (name) query.set("name", name);
    return this.request<CloudflareZone[]>(`/zones?${query.toString()}`);
  }

  async listWorkers(): Promise<CloudflareWorkerScript[]> {
    const account = this.requireAccount();
    return this.request<CloudflareWorkerScript[]>(
      `/accounts/${account}/workers/scripts?per_page=100`
    );
  }

  async getWorkerTag(workerName: string): Promise<string | null> {
    const scripts = await this.listWorkers();
    return scripts.find((script) => script.id === workerName)?.tag ?? null;
  }

  /**
   * Creates a Worker with a placeholder script so Workers Builds can target it.
   * The first successful build replaces this script and its assets.
   */
  async ensurePlaceholderWorker(workerName: string, compatibilityDate: string): Promise<string> {
    const account = this.requireAccount();
    const scripts = await this.listWorkers();
    const existing = scripts.find((script) => script.id === workerName);
    if (existing?.tag) return existing.tag;

    const script = `export default {
  async fetch() {
    return new Response(
      "KI00 project created. The first successful deployment has not finished yet.\\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" } }
    );
  },
};`;

    const metadata = {
      main_module: `${workerName}.mjs`,
      compatibility_date: compatibilityDate,
      bindings: [],
      observability: { enabled: true },
    };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append(
      `${workerName}.mjs`,
      new Blob([script], { type: "application/javascript+module" }),
      `${workerName}.mjs`
    );

    try {
      await this.request<unknown>(`/accounts/${account}/workers/scripts/${workerName}`, {
        method: "PUT",
        body: form,
      });
    } catch (error) {
      // A concurrent request may already have created the Worker.
      const tag = await this.getWorkerTag(workerName).catch(() => null);
      if (tag) return tag;
      throw error;
    }

    const tag = await this.getWorkerTag(workerName);
    if (!tag) {
      throw new ProviderError("cloudflare", 502, "Worker was created but has no tag yet", {
        code: "CLOUDFLARE_WORKER_TAG_MISSING",
        hint: "Retry the deployment in a moment; the Workers API is still propagating the new script.",
      });
    }
    return tag;
  }

  async deleteWorker(workerName: string): Promise<void> {
    const account = this.requireAccount();
    await this.request<unknown>(`/accounts/${account}/workers/scripts/${workerName}?force=true`, {
      method: "DELETE",
    });
  }

  async listBuildTokens(): Promise<CloudflareBuildToken[]> {
    const account = this.requireAccount();
    return this.request<CloudflareBuildToken[]>(`/accounts/${account}/builds/tokens`);
  }

  async ensureBuildToken(input: {
    uuid?: string | null;
    secret?: string | null;
    tokenId?: string | null;
  }): Promise<{ uuid: string; source: "env" | "existing" | "created" }> {
    if (input.uuid) return { uuid: input.uuid, source: "env" };
    if (!input.secret || !input.tokenId) {
      throw new ProviderError(
        "cloudflare",
        424,
        "No Workers Builds build token is configured",
        {
          code: "CLOUDFLARE_BUILD_TOKEN_MISSING",
          hint: "Create a dedicated API token with only Workers Scripts:Edit, then set KI00_BUILD_TOKEN_UUID (from Workers & Pages → your Worker → Settings → Builds) or both KI00_BUILD_TOKEN_SECRET and KI00_BUILD_TOKEN_ID. KI00 never reuses its own broader token for builds.",
        }
      );
    }
    const account = this.requireAccount();
    const tokens = await this.listBuildTokens();
    const named = tokens.find((token) => token.build_token_name === "ki00-build");
    if (named?.build_token_uuid) return { uuid: named.build_token_uuid, source: "existing" };
    if (tokens.length > 0 && tokens[0]?.build_token_uuid) {
      return { uuid: tokens[0].build_token_uuid, source: "existing" };
    }

    try {
      const created = await this.request<CloudflareBuildToken>(`/accounts/${account}/builds/tokens`, {
        method: "POST",
        body: JSON.stringify({
          build_token_name: "ki00-build",
          build_token_secret: input.secret,
          cloudflare_token_id: input.tokenId,
        }),
      });
      if (!created?.build_token_uuid) throw new Error("missing build_token_uuid");
      return { uuid: created.build_token_uuid, source: "created" };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new ProviderError("cloudflare", error.status, error.message, {
          code: "CLOUDFLARE_BUILD_TOKEN_FAILED",
          hint: "Create a build token in the Cloudflare dashboard (Worker → Settings → Builds → API token) and set KI00_BUILD_TOKEN_UUID, or set KI00_BUILD_TOKEN_SECRET and KI00_BUILD_TOKEN_ID.",
          details: error.details,
        });
      }
      throw error;
    }
  }

  async listRepoConnections(): Promise<CloudflareRepoConnection[]> {
    const account = this.requireAccount();
    return this.request<CloudflareRepoConnection[]>(`/accounts/${account}/builds/repos/connections`);
  }

  async ensureRepoConnection(input: {
    providerAccountId: string;
    providerAccountName: string;
    repoId: string;
    repoName: string;
  }): Promise<string> {
    const account = this.requireAccount();
    const existing = await this.listRepoConnections().catch(() => []);
    const match = existing.find(
      (connection) =>
        connection.provider_type === "github" &&
        String(connection.repo_id) === String(input.repoId) &&
        connection.provider_account_id === input.providerAccountId
    );
    if (match?.repo_connection_uuid) return match.repo_connection_uuid;

    const created = await this.request<CloudflareRepoConnection>(
      `/accounts/${account}/builds/repos/connections`,
      {
        method: "PUT",
        body: JSON.stringify({
          provider_type: "github",
          provider_account_id: input.providerAccountId,
          provider_account_name: input.providerAccountName,
          repo_id: String(input.repoId),
          repo_name: input.repoName,
        }),
      }
    );
    if (!created?.repo_connection_uuid) {
      throw new ProviderError("cloudflare", 502, "Cloudflare did not return a repository connection id", {
        code: "CLOUDFLARE_REPO_CONNECTION_MISSING",
        hint: "Install the Cloudflare GitHub App for this repository, then retry.",
      });
    }
    return created.repo_connection_uuid;
  }

  async listTriggers(workerTag: string): Promise<CloudflareBuildTrigger[]> {
    const account = this.requireAccount();
    return this.request<CloudflareBuildTrigger[]>(
      `/accounts/${account}/builds/workers/${encodeURIComponent(workerTag)}/triggers`
    );
  }

  async createTrigger(input: {
    workerTag: string;
    repoConnectionUuid: string;
    buildTokenUuid: string;
    name: string;
    buildCommand: string;
    deployCommand: string;
    rootDirectory: string;
    branchIncludes: string[];
    branchExcludes: string[];
    buildCaching: boolean;
  }): Promise<CloudflareBuildTrigger> {
    const account = this.requireAccount();
    return this.request<CloudflareBuildTrigger>(`/accounts/${account}/builds/triggers`, {
      method: "POST",
      body: JSON.stringify({
        external_script_id: input.workerTag,
        repo_connection_uuid: input.repoConnectionUuid,
        build_token_uuid: input.buildTokenUuid,
        trigger_name: input.name,
        build_command: input.buildCommand || "true",
        deploy_command: input.deployCommand,
        root_directory: input.rootDirectory || "/",
        branch_includes: input.branchIncludes,
        branch_excludes: input.branchExcludes,
        path_includes: ["*"],
        path_excludes: [],
        build_caching_enabled: input.buildCaching,
      }),
    });
  }

  async updateTrigger(
    triggerUuid: string,
    input: Partial<{
      buildCommand: string;
      deployCommand: string;
      rootDirectory: string;
      branchIncludes: string[];
      branchExcludes: string[];
      buildCaching: boolean;
    }>
  ): Promise<CloudflareBuildTrigger> {
    const account = this.requireAccount();
    const body: Record<string, unknown> = {};
    if (input.buildCommand !== undefined) body.build_command = input.buildCommand || "true";
    if (input.deployCommand !== undefined) body.deploy_command = input.deployCommand;
    if (input.rootDirectory !== undefined) body.root_directory = input.rootDirectory || "/";
    if (input.branchIncludes !== undefined) body.branch_includes = input.branchIncludes;
    if (input.branchExcludes !== undefined) body.branch_excludes = input.branchExcludes;
    if (input.buildCaching !== undefined) body.build_caching_enabled = input.buildCaching;
    return this.request<CloudflareBuildTrigger>(
      `/accounts/${account}/builds/triggers/${triggerUuid}`,
      { method: "PATCH", body: JSON.stringify(body) }
    );
  }

  async deleteTrigger(triggerUuid: string): Promise<void> {
    const account = this.requireAccount();
    await this.request<unknown>(`/accounts/${account}/builds/triggers/${triggerUuid}`, {
      method: "DELETE",
    });
  }

  async setTriggerEnvironmentVariables(
    triggerUuid: string,
    variables: Record<string, { value: string; isSecret: boolean }>
  ): Promise<void> {
    const account = this.requireAccount();
    const payload: Record<string, { value: string; is_secret: boolean }> = {};
    for (const [key, value] of Object.entries(variables)) {
      payload[key] = { value: value.value, is_secret: value.isSecret };
    }
    await this.request<unknown>(
      `/accounts/${account}/builds/triggers/${triggerUuid}/environment_variables`,
      { method: "PATCH", body: JSON.stringify(payload) }
    );
  }

  async deleteTriggerEnvironmentVariable(triggerUuid: string, key: string): Promise<void> {
    const account = this.requireAccount();
    await this.request<unknown>(
      `/accounts/${account}/builds/triggers/${triggerUuid}/environment_variables/${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
  }

  async triggerBuild(
    triggerUuid: string,
    input: { branch?: string; commitHash?: string } = {}
  ): Promise<CloudflareBuild> {
    const account = this.requireAccount();
    return this.request<CloudflareBuild>(
      `/accounts/${account}/builds/triggers/${triggerUuid}/builds`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.commitHash ? { commit_hash: input.commitHash } : {}),
        }),
      }
    );
  }

  async getBuild(buildUuid: string): Promise<CloudflareBuild> {
    const account = this.requireAccount();
    return this.request<CloudflareBuild>(
      `/accounts/${account}/builds/builds/${encodeURIComponent(buildUuid)}`
    );
  }

  async listBuilds(workerTag: string, page = 1): Promise<CloudflareBuild[]> {
    const account = this.requireAccount();
    return this.request<CloudflareBuild[]>(
      `/accounts/${account}/builds/workers/${encodeURIComponent(workerTag)}/builds?page=${page}&per_page=25`
    );
  }

  async getBuildLogs(buildUuid: string, cursor?: string): Promise<CloudflareBuildLogs> {
    const account = this.requireAccount();
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request<CloudflareBuildLogs>(
      `/accounts/${account}/builds/builds/${encodeURIComponent(buildUuid)}/logs${query}`,
      {},
      { timeoutMs: 30_000 }
    );
  }

  async cancelBuild(buildUuid: string): Promise<void> {
    const account = this.requireAccount();
    await this.request<unknown>(
      `/accounts/${account}/builds/builds/${encodeURIComponent(buildUuid)}/cancel`,
      { method: "PUT" }
    );
  }

  async getBuildLimits(): Promise<BuildLimits> {
    const account = this.requireAccount();
    const raw = await this.request<Record<string, unknown>>(
      `/accounts/${account}/builds/account/limits`
    );
    const pick = (keys: string[]): number | null => {
      for (const key of keys) {
        const value = raw?.[key];
        if (typeof value === "number") return value;
        if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) return Number(value);
      }
      return null;
    };
    return {
      remainingMinutes: pick([
        "build_minutes_available",
        "available_minutes",
        "minutes_available",
        "remaining",
        "build_minutes_remaining",
      ]),
      limitMinutes: pick([
        "build_minutes_limit",
        "included_minutes",
        "minutes_limit",
        "limit",
        "build_minutes_total",
      ]),
      raw,
    };
  }

  async listDomains(service?: string): Promise<CloudflareDomain[]> {
    const account = this.requireAccount();
    const query = new URLSearchParams();
    if (service) query.set("service", service);
    return this.request<CloudflareDomain[]>(
      `/accounts/${account}/workers/domains${query.size ? `?${query.toString()}` : ""}`
    );
  }

  async attachDomain(input: {
    hostname: string;
    service: string;
    zoneId: string;
  }): Promise<CloudflareDomain> {
    const account = this.requireAccount();
    return this.request<CloudflareDomain>(`/accounts/${account}/workers/domains`, {
      method: "PUT",
      body: JSON.stringify({
        hostname: input.hostname,
        service: input.service,
        zone_id: input.zoneId,
        environment: "production",
      }),
    });
  }

  async removeDomain(domainId: string): Promise<void> {
    const account = this.requireAccount();
    await this.request<unknown>(
      `/accounts/${account}/workers/domains/${encodeURIComponent(domainId)}`,
      { method: "DELETE" }
    );
  }

  async putWorkerSecrets(
    workerName: string,
    secrets: Record<string, string | null>
  ): Promise<Record<string, unknown>> {
    const account = this.requireAccount();
    const wrapped: Record<string, { name: string; text: string; type: "secret_text" } | null> = {};
    for (const [key, value] of Object.entries(secrets)) {
      wrapped[key] =
        value === null ? null : { name: key, text: value, type: "secret_text" };
    }
    return this.request<Record<string, unknown>>(
      `/accounts/${account}/workers/scripts/${encodeURIComponent(workerName)}/secrets-bulk`,
      { method: "PATCH", body: JSON.stringify({ secrets: wrapped }) }
    );
  }

  async deleteWorkerSecret(workerName: string, key: string): Promise<void> {
    const account = this.requireAccount();
    await this.request<unknown>(
      `/accounts/${account}/workers/scripts/${encodeURIComponent(workerName)}/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
  }

  async queryRuntimeLogs(input: RuntimeLogQuery): Promise<RuntimeLogResult> {
    const account = this.requireAccount();
    const filters: unknown[] = [
      {
        id: newId("flt"),
        key: "$metadata.service",
        type: "string",
        operation: "eq",
        value: input.scriptName,
      },
    ];
    if (input.level && input.level !== "all") {
      filters.push({
        id: newId("flt"),
        key: "$metadata.level",
        type: "string",
        operation: "eq",
        value: input.level,
      });
    }
    if (input.text) {
      filters.push({
        id: newId("flt"),
        key: "$metadata.message",
        type: "string",
        operation: "includes",
        value: input.text.slice(0, 120),
      });
    }

    try {
      const result = await this.request<{ events?: Record<string, unknown>[] }>(
        `/accounts/${account}/workers/observability/telemetry/query`,
        {
          method: "POST",
          body: JSON.stringify({
            queryId: newId("qry"),
            timeframe: { from: input.from, to: input.to },
            limit: Math.min(input.limit ?? 100, 200),
            view: "events",
            dry: false,
            parameters: { datasets: ["cloudflare-workers"], filters },
          }),
        },
        { timeoutMs: 30_000, retries: 0 }
      );
      const events = result.events ?? [];
      return {
        available: true,
        error: null,
        lines: events.map(normalizeTelemetryEvent),
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        return {
          available: false,
          error:
            error.status === 403 || error.status === 401
              ? "This API token cannot read Workers Observability logs. Add Workers Observability: Read to the token."
              : error.message,
          lines: [],
        };
      }
      return { available: false, error: "Runtime logs are unavailable", lines: [] };
    }
  }
}

function normalizeTelemetryEvent(event: Record<string, unknown>): LogLine {
  const metadata = (event.$metadata ?? {}) as Record<string, unknown>;
  const timestamp =
    numberFrom(metadata.timestamp) ??
    numberFrom(metadata.time) ??
    numberFrom(event.timestamp) ??
    numberFrom(event.timestampMs) ??
    null;
  const rawLevel = String(metadata.level ?? event.level ?? "info").toLowerCase();
  const level: LogLine["level"] =
    rawLevel === "error" || rawLevel === "warn" || rawLevel === "debug"
      ? (rawLevel as LogLine["level"])
      : "info";
  const message =
    stringFrom(metadata.message) ??
    stringFrom(event.message) ??
    stringFrom(metadata.outcome) ??
    JSON.stringify(event).slice(0, 4000);
  return {
    ts: timestamp && timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp,
    level,
    text: message,
  };
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function hintForCloudflareError(status: number, message: string, code?: number): string {
  const lower = message.toLowerCase();
  if (status === 401 || code === 10000 || lower.includes("authentication")) {
    return "The Cloudflare API token is invalid or expired. Create a new user-scoped token and update the CLOUDFLARE_API_TOKEN Worker secret.";
  }
  if (status === 403 || lower.includes("unauthorized") || lower.includes("not authorized")) {
    return "The token is valid but lacks a permission required for this call. Review the permission list in docs/CLOUDFLARE_SETUP.md.";
  }
  if (lower.includes("invalid token") && lower.includes("build")) {
    return "Workers Builds requires a user-scoped API token. Account-owned tokens are not supported by the Builds API.";
  }
  if (status === 404) {
    return "The resource was not found in this Cloudflare account. Confirm CLOUDFLARE_ACCOUNT_ID and that the Worker exists.";
  }
  if (status === 409) {
    return "Cloudflare reports a conflicting resource. Refresh the project state and retry.";
  }
  if (status === 429) {
    return "Cloudflare rate-limited this request. Wait a moment and retry.";
  }
  if (lower.includes("github") && (lower.includes("not connected") || lower.includes("install"))) {
    return "Install the Cloudflare GitHub App on this repository (one-time, in the Cloudflare dashboard) before deploying.";
  }
  return "See the Cloudflare API error above. docs/CLOUDFLARE_SETUP.md documents the exact token permissions.";
}

/** The token/account pair used by the dashboard for unauthenticated capability checks. */
export function hasCloudflareCredentials(env: {
  CLOUDFLARE_API_TOKEN?: string;
}): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN);
}
