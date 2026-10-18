import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { ConnectionsInfo, SessionRecord } from "../../shared/types";
import { requireAuth } from "../lib/auth";
import { dbAll, dbRun } from "../lib/db";
import { getCapabilities, invalidateProviderStatus, isDemo } from "../lib/providers";
import { clientForWorkspace } from "../lib/deploy-engine";
import { GitHubClient } from "../lib/github";
import { OpenRouterClient } from "../lib/openrouter";
import { getModelCatalog } from "../lib/models";
import { recordAudit } from "../lib/activity";
import { now } from "../lib/utils";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/settings/connections", async (c) => {
  const { workspace } = requireAuth(c);
  const capabilities = await getCapabilities(c.env, { force: true });
  const demo = isDemo(c.env);

  const cloudflare: ConnectionsInfo["cloudflare"] = {
    accountName: workspace.cloudflareAccountName ?? capabilities.providers.cloudflare.accountName ?? null,
    accountId: workspace.cloudflareAccountId ?? capabilities.providers.cloudflare.accountId ?? null,
    workersSubdomain: capabilities.providers.cloudflare.workersSubdomain ?? null,
    zones: [],
    workerCount: null,
    buildMinutes: { remaining: null, limit: null, error: null },
    buildToken: capabilities.providers.cloudflare.buildToken ?? "unknown",
    permissionHint:
      "User-scoped token with Workers Scripts:Edit, Workers Builds Configuration:Edit, Workers KV/R2/D1:Edit, Workers Observability:Read, Account Settings:Read, Zone:Read and Workers Routes:Edit.",
    docsUrl: "https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/",
  };

  if (!demo && capabilities.providers.cloudflare.configured && capabilities.providers.cloudflare.ok) {
    try {
      const { client } = await clientForWorkspace(c.env, workspace.id);
      const [zones, workers, limits] = await Promise.allSettled([
        client.listZones(),
        client.listWorkers(),
        client.getBuildLimits(),
      ]);
      if (zones.status === "fulfilled") {
        cloudflare.zones = zones.value.map((zone) => ({
          id: zone.id,
          name: zone.name,
          status: zone.status,
        }));
      }
      if (workers.status === "fulfilled") cloudflare.workerCount = workers.value.length;
      if (limits.status === "fulfilled") {
        cloudflare.buildMinutes = {
          remaining: limits.value.remainingMinutes,
          limit: limits.value.limitMinutes,
          error: null,
        };
      } else {
        cloudflare.buildMinutes.error =
          limits.reason instanceof Error ? limits.reason.message : "Build limits unavailable";
      }
    } catch (error) {
      cloudflare.buildMinutes.error = error instanceof Error ? error.message : "Cloudflare API error";
    }
  }

  const githubClient = GitHubClient.fromEnv(c.env);
  const github: ConnectionsInfo["github"] = {
    mode: githubClient.authenticated ? "token" : "public",
    login: null,
    rateLimit: { limit: null, remaining: null, resetAt: null },
    requiredScopes: ["Metadata: Read", "Contents: Read", "Contents: Write (only for agent patch branches)"],
    docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  };
  if (!demo) {
    github.rateLimit = await githubClient.getRateLimit();
    if (githubClient.authenticated) {
      try {
        github.login = (await githubClient.getUser()).login;
      } catch {
        github.login = null;
      }
    }
  }

  const openrouter: ConnectionsInfo["openrouter"] = {
    freeModels: 0,
    selectedModel: null,
    selectedModelName: null,
    keyLabel: null,
    usage: null,
    docsUrl: "https://openrouter.ai/docs/api-reference/overview",
  };
  if (!demo && capabilities.providers.openrouter.configured) {
    try {
      const catalog = await getModelCatalog(c.env);
      openrouter.freeModels = catalog.models.length;
      openrouter.selectedModel = catalog.selectedModel;
      openrouter.selectedModelName = catalog.selectedModelName;
      const client = OpenRouterClient.fromEnv(c.env);
      const key = await client.keyInfo();
      openrouter.keyLabel = key.label;
      openrouter.usage = {
        usage: key.usage,
        limit: key.limit,
        isFreeTier: key.isFreeTier,
      };
    } catch (error) {
      openrouter.usage = null;
      openrouter.keyLabel = error instanceof Error ? error.message : null;
    }
  }

  const payload: ConnectionsInfo = {
    capabilities,
    cloudflare,
    github,
    openrouter,
    encryption: { configured: capabilities.providers.encryption.configured },
    demo,
  };
  return c.json(payload);
});

settingsRoutes.post("/settings/refresh", async (c) => {
  const { workspace } = requireAuth(c);
  await invalidateProviderStatus(c.env);
  const capabilities = await getCapabilities(c.env, { force: true });
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "settings.providers.refresh",
    targetType: "workspace",
    targetId: workspace.id,
  });
  return c.json({ capabilities, refreshedAt: now() });
});

settingsRoutes.get("/settings/sessions", async (c) => {
  const { user, session } = requireAuth(c);
  const rows = await dbAll<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC",
    user.id
  );
  const items: SessionRecord[] = rows.map((row) => ({
    current: row.token_hash === session.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    userAgent: row.user_agent,
    ipHash: row.ip_hash ? String(row.ip_hash).slice(0, 10) : null,
  }));
  return c.json({ items });
});

settingsRoutes.post("/settings/sessions/revoke-others", async (c) => {
  const { user, session, workspace } = requireAuth(c);
  await dbRun(
    c.env.DB,
    "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
    user.id,
    session.token_hash
  );
  await recordAudit(c, {
    workspaceId: workspace.id,
    action: "session.revoke_others",
    targetType: "user",
    targetId: user.id,
  });
  return c.json({ ok: true });
});

settingsRoutes.get("/settings/system", async (c) => {
  requireAuth(c);
  const capabilities = await getCapabilities(c.env);
  return c.json({
    version: capabilities.version,
    env: capabilities.env,
    demo: capabilities.demo,
    setupComplete: capabilities.setupComplete,
    providers: {
      cloudflare: {
        configured: capabilities.providers.cloudflare.configured,
        ok: capabilities.providers.cloudflare.ok,
      },
      github: { configured: capabilities.providers.github.configured, ok: capabilities.providers.github.ok },
      openrouter: {
        configured: capabilities.providers.openrouter.configured,
        ok: capabilities.providers.openrouter.ok,
      },
      encryption: capabilities.providers.encryption,
    },
    limits: capabilities.limits,
    runtime: "Cloudflare Workers",
    buildEngine: "Cloudflare Workers Builds",
    database: "Cloudflare D1",
    docs: {
      setup: "docs/CLOUDFLARE_SETUP.md",
      deployment: "docs/DEPLOYMENT.md",
      security: "docs/SECURITY.md",
      compatibility: "docs/RUNTIME_COMPATIBILITY.md",
    },
  });
});
