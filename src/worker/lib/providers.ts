import type { Capabilities, ProviderStatus } from "../../shared/types";
import type { Env } from "../env";
import { APP_VERSION } from "../env";
import { getSetting, getSettings, setSetting } from "./db";
import { countUsers } from "./auth";
import { CloudflareClient } from "./cloudflare";
import { isEncryptionConfigured } from "./crypto";
import { GitHubClient } from "./github";
import { getModelCatalog } from "./models";
import { now } from "./utils";

const STATUS_CACHE_KEY = "ki00:provider-status";
const STATUS_TTL_MS = 2 * 60 * 1000;

interface CachedStatuses {
  at: number;
  cloudflare: Capabilities["providers"]["cloudflare"];
  github: Capabilities["providers"]["github"];
  openrouter: Capabilities["providers"]["openrouter"];
}

export function isDemo(env: Env): boolean {
  return env.KI00_DEMO === "1" || env.KI00_DEMO === "true";
}

export function cloudflareConfigured(env: Env): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN);
}

export async function getCapabilities(
  env: Env,
  options: { force?: boolean } = {}
): Promise<Capabilities> {
  const users = await countUsers(env.DB);
  const cached = await readStatusCache(env);
  let statuses: CachedStatuses;

  if (!options.force && cached && now() - cached.at < STATUS_TTL_MS) {
    statuses = cached;
  } else {
    const [cloudflare, github, openrouter] = await Promise.all([
      checkCloudflare(env),
      checkGitHub(env),
      checkOpenRouter(env),
    ]);
    statuses = { at: now(), cloudflare, github, openrouter };
    await setSetting(env.DB, STATUS_CACHE_KEY, JSON.stringify(statuses)).catch(() => undefined);
  }

  const buildTokenSetting = statuses.cloudflare.accountId
    ? await getSetting(env.DB, `cf:build-token:${statuses.cloudflare.accountId}`)
    : null;

  return {
    setupComplete: users > 0,
    demo: isDemo(env),
    env: env.KI00_ENV ?? "production",
    version: APP_VERSION,
    providers: {
      cloudflare: {
        ...statuses.cloudflare,
        buildToken:
          env.KI00_BUILD_TOKEN_UUID || (env.KI00_BUILD_TOKEN_SECRET && env.KI00_BUILD_TOKEN_ID)
            ? "configured"
            : buildTokenSetting
              ? "configured"
              : statuses.cloudflare.ok
                ? "unknown"
                : "missing",
      },
      github: statuses.github,
      openrouter: statuses.openrouter,
      encryption: { configured: isEncryptionConfigured(env.KI00_ENCRYPTION_KEY) },
      setup: { tokenConfigured: Boolean(env.KI00_SETUP_TOKEN) },
    },
    limits: {
      agentModelCallsPerRun: 8,
      agentRunsPerHour: 10,
      deploysPerHour: 12,
    },
  };
}

async function checkCloudflare(env: Env): Promise<Capabilities["providers"]["cloudflare"]> {
  if (isDemo(env)) {
    return {
      configured: false,
      ok: null,
      identity: null,
      detail: "Demo mode: no Cloudflare API calls are made.",
      error: null,
      errorHint: null,
      checkedAt: now(),
      accountId: null,
      accountName: "Demo Account (sample)",
      workersSubdomain: null,
    };
  }
  const base = {
    configured: cloudflareConfigured(env),
    ok: null as boolean | null,
    identity: null as string | null,
    detail: null as string | null,
    error: null as string | null,
    errorHint: null as string | null,
    checkedAt: now(),
    accountId: (env.CLOUDFLARE_ACCOUNT_ID || env.KI00_DEFAULT_ACCOUNT_ID) ?? null,
    accountName: null as string | null,
    workersSubdomain: null as string | null,
  };
  if (!base.configured) {
    return { ...base, error: null, detail: "Cloudflare is not connected yet." };
  }
  try {
    const client = new CloudflareClient({
      token: env.CLOUDFLARE_API_TOKEN!,
      accountId: base.accountId,
    });
    const token = await client.verifyToken();
    base.ok = token.status === "active";
    base.identity = token.id;
    base.detail = token.expires_on ? `Token expires ${token.expires_on}` : "User API token verified";

    if (!base.accountId) {
      try {
        const accounts = await client.listAccounts();
        if (accounts[0]) {
          base.accountId = accounts[0].id;
          base.accountName = accounts[0].name;
        }
      } catch {
        /* account-scoped token without account list permission */
      }
    }
    if (base.accountId) {
      const scoped = new CloudflareClient({
        token: env.CLOUDFLARE_API_TOKEN!,
        accountId: base.accountId,
      });
      const [subdomain, settings] = await Promise.all([
        scoped.getWorkersSubdomain(),
        getSettings(env.DB, [`cf:account-name:${base.accountId}`]),
      ]);
      base.workersSubdomain = subdomain;
      base.accountName = base.accountName ?? settings[`cf:account-name:${base.accountId}`] ?? null;
      if (!base.accountName) {
        try {
          const accounts = await scoped.listAccounts();
          const match = accounts.find((account) => account.id === base.accountId);
          if (match) {
            base.accountName = match.name;
            await setSetting(env.DB, `cf:account-name:${match.id}`, match.name);
          }
        } catch {
          /* optional */
        }
      }
    }
    return base;
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : "Cloudflare verification failed",
      errorHint:
        "Check CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The token must be user-scoped and include Workers Scripts:Edit and Workers Builds Configuration:Edit.",
    };
  }
}

async function checkGitHub(env: Env): Promise<Capabilities["providers"]["github"]> {
  if (isDemo(env)) {
    return {
      configured: false,
      ok: null,
      identity: null,
      detail: "Demo mode: GitHub is not queried.",
      error: null,
      errorHint: null,
      checkedAt: now(),
      login: null,
      scopes: null,
      mode: "public",
    };
  }
  const base = {
    configured: Boolean(env.GITHUB_TOKEN),
    ok: null as boolean | null,
    identity: null as string | null,
    detail: null as string | null,
    error: null as string | null,
    errorHint: null as string | null,
    checkedAt: now(),
    login: null as string | null,
    scopes: null as string | null,
    mode: (env.GITHUB_TOKEN ? "token" : "public") as "token" | "public",
  };
  const client = GitHubClient.fromEnv(env);
  try {
    if (client.authenticated) {
      const [user, rate] = await Promise.all([client.getUser(), client.getRateLimit()]);
      base.ok = true;
      base.login = user.login;
      base.identity = user.login;
      base.detail = rate.limit
        ? `${rate.remaining ?? 0}/${rate.limit} REST requests remaining`
        : "Authenticated";
      return base;
    }
    const rate = await client.getRateLimit();
    base.ok = true;
    base.detail = `Public API only · ${rate.remaining ?? 0}/${rate.limit ?? 60} requests remaining`;
    base.error = null;
    return base;
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : "GitHub verification failed",
      errorHint: "Replace GITHUB_TOKEN with a valid fine-grained PAT (Metadata:Read, Contents:Read).",
    };
  }
}

async function checkOpenRouter(env: Env): Promise<Capabilities["providers"]["openrouter"]> {
  if (isDemo(env)) {
    return {
      configured: false,
      ok: null,
      identity: null,
      detail: "Demo mode: OpenRouter is not queried.",
      error: null,
      errorHint: null,
      checkedAt: now(),
      freeModels: null,
      selectedModel: null,
    };
  }
  const base = {
    configured: Boolean(env.OPENROUTER_API_KEY),
    ok: null as boolean | null,
    identity: null as string | null,
    detail: null as string | null,
    error: null as string | null,
    errorHint: null as string | null,
    checkedAt: now(),
    freeModels: null as number | null,
    selectedModel: null as string | null,
  };
  if (!base.configured) {
    return { ...base, detail: "OpenRouter is not configured; the AI agent is disabled." };
  }
  try {
    const catalog = await getModelCatalog(env);
    base.freeModels = catalog.models.length;
    base.selectedModel = catalog.selectedModel;
    base.identity = catalog.selectedModelName;
    base.ok = catalog.models.length > 0 && !catalog.error;
    base.detail = catalog.selectedModel
      ? `${catalog.models.length} free tool-capable models · selected ${catalog.selectedModel}`
      : "No free tool-capable model is currently available.";
    base.error = catalog.error;
    base.errorHint = catalog.error
      ? "Check OPENROUTER_API_KEY and network access to openrouter.ai. KI00 never falls back to a paid model."
      : null;
    return base;
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : "OpenRouter verification failed",
      errorHint: "Check the OPENROUTER_API_KEY Worker secret.",
    };
  }
}

async function readStatusCache(env: Env): Promise<CachedStatuses | null> {
  const raw = await getSetting(env.DB, STATUS_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedStatuses;
    if (!parsed.at || !parsed.cloudflare || !parsed.github || !parsed.openrouter) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function invalidateProviderStatus(env: Env): Promise<void> {
  await setSetting(env.DB, STATUS_CACHE_KEY, JSON.stringify({ at: 0 })).catch(() => undefined);
}

export function publicProviderStatus(status: ProviderStatus): ProviderStatus {
  return {
    configured: status.configured,
    ok: status.ok,
    identity: status.identity ?? null,
    detail: status.detail ?? null,
    error: status.error ?? null,
    errorHint: status.errorHint ?? null,
    checkedAt: status.checkedAt ?? null,
  };
}
