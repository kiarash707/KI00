import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { Activity, Overview, QuotaInfo } from "../../shared/types";
import { requireAuth } from "../lib/auth";
import { forbidden } from "../lib/errors";
import { dbAll, dbFirst, getSetting, setSetting } from "../lib/db";
import { mapActivity, mapDeployment, mapProject } from "../lib/mappers";
import { getCapabilities, isDemo } from "../lib/providers";
import { clientForWorkspace, syncActiveDeployments } from "../lib/deploy-engine";
import { GitHubClient } from "../lib/github";
import { getModelCatalog } from "../lib/models";
import { parsePagination } from "./helpers";
import { now } from "../lib/utils";

export const overviewRoutes = new Hono<AppEnv>();

overviewRoutes.get("/overview", async (c) => {
  const { workspace } = requireAuth(c);
  const capabilities = await getCapabilities(c.env);
  const ts = now();
  const since14 = ts - 14 * 86_400_000;

  const [statsRow, buildingRow, sparkRows, recentDeployments, activityRows, errorRows, storage] =
    await Promise.all([
      dbFirst<{ deployments: number; successful: number; failed: number; last7d: number; last7dFailed: number }>(
        c.env.DB,
        `SELECT COUNT(*) AS deployments,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last7d,
          SUM(CASE WHEN created_at >= ? AND status = 'failed' THEN 1 ELSE 0 END) AS last7dFailed
         FROM deployments WHERE workspace_id = ?`,
        ts - 7 * 86_400_000,
        ts - 7 * 86_400_000,
        workspace.id
      ),
      dbFirst<{ count: number }>(
        c.env.DB,
        "SELECT COUNT(*) AS count FROM deployments WHERE workspace_id = ? AND status IN ('queued','initializing','running')",
        workspace.id
      ),
      dbAll<{ day: string; success: number; failed: number }>(
        c.env.DB,
        `SELECT date(created_at / 1000, 'unixepoch') AS day,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM deployments WHERE workspace_id = ? AND created_at >= ?
         GROUP BY day`,
        workspace.id,
        since14
      ),
      dbAll<Record<string, any>>(
        c.env.DB,
        `SELECT d.*, p.name AS project_name, p.slug AS project_slug
         FROM deployments d JOIN projects p ON p.id = d.project_id
         WHERE d.workspace_id = ? ORDER BY d.created_at DESC LIMIT 8`,
        workspace.id
      ),
      dbAll<Record<string, any>>(
        c.env.DB,
        `SELECT a.*, p.name AS project_name FROM activities a LEFT JOIN projects p ON p.id = a.project_id
         WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT 12`,
        workspace.id
      ),
      dbAll<Record<string, any>>(
        c.env.DB,
        `SELECT a.*, p.name AS project_name FROM activities a LEFT JOIN projects p ON p.id = a.project_id
         WHERE a.workspace_id = ? AND a.level = 'error' ORDER BY a.created_at DESC LIMIT 5`,
        workspace.id
      ),
      dbFirst<{ deployments: number; logBytes: number; envVars: number; domains: number }>(
        c.env.DB,
        `SELECT
          (SELECT COUNT(*) FROM deployments WHERE workspace_id = ?) AS deployments,
          (SELECT COALESCE(SUM(logs_bytes),0) FROM deployments WHERE workspace_id = ?) AS logBytes,
          (SELECT COUNT(*) FROM env_vars e JOIN projects p ON p.id = e.project_id WHERE p.workspace_id = ?) AS envVars,
          (SELECT COUNT(*) FROM domains d JOIN projects p ON p.id = d.project_id WHERE p.workspace_id = ?) AS domains`,
        workspace.id,
        workspace.id,
        workspace.id,
        workspace.id
      ),
    ]);

  const projectCount = await dbFirst<{ count: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS count FROM projects WHERE workspace_id = ?",
    workspace.id
  );

  const sparkMap = new Map(sparkRows.map((row) => [row.day, row]));
  const sparkline = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(ts - (13 - index) * 86_400_000).toISOString().slice(0, 10);
    const row = sparkMap.get(date);
    return { day: date, success: Number(row?.success ?? 0), failed: Number(row?.failed ?? 0) };
  });

  let workerCount: number | null = null;
  let buildMinutes: { remaining: number | null; limit: number | null; error: string | null } = {
    remaining: null,
    limit: null,
    error: null,
  };
  let githubRate: { limit: number | null; remaining: number | null; resetAt: number | null } = {
    limit: null,
    remaining: null,
    resetAt: null,
  };
  let openrouterFree: number | null = null;

  if (!isDemo(c.env)) {
    if (capabilities.providers.cloudflare.configured && capabilities.providers.cloudflare.ok) {
      try {
        const { client } = await clientForWorkspace(c.env, workspace.id);
        const [scripts, limits] = await Promise.allSettled([
          client.listWorkers(),
          client.getBuildLimits(),
        ]);
        if (scripts.status === "fulfilled") workerCount = scripts.value.length;
        if (limits.status === "fulfilled") {
          buildMinutes = {
            remaining: limits.value.remainingMinutes,
            limit: limits.value.limitMinutes,
            error: null,
          };
        } else {
          buildMinutes.error =
            limits.reason instanceof Error ? limits.reason.message : "Build minute availability is unavailable";
        }
      } catch (error) {
        buildMinutes.error = error instanceof Error ? error.message : "Cloudflare API error";
      }
    } else if (capabilities.providers.cloudflare.configured) {
      buildMinutes.error = capabilities.providers.cloudflare.error ?? null;
    }

    if (capabilities.providers.github.ok) {
      githubRate = await GitHubClient.fromEnv(c.env).getRateLimit();
    }
    if (capabilities.providers.openrouter.configured) {
      try {
        const catalog = await getModelCatalog(c.env);
        openrouterFree = catalog.models.length;
      } catch {
        openrouterFree = null;
      }
    }
  }

  const quotas = buildQuotas(buildMinutes);

  const stats = {
    projects: Number(projectCount?.count ?? 0),
    deployments: Number(statsRow?.deployments ?? 0),
    successful: Number(statsRow?.successful ?? 0),
    failed: Number(statsRow?.failed ?? 0),
    building: Number(buildingRow?.count ?? 0),
    successRate:
      Number(statsRow?.deployments ?? 0) > 0
        ? Math.round((Number(statsRow?.successful ?? 0) / Number(statsRow?.deployments ?? 1)) * 1000) / 10
        : null,
    last7d: Number(statsRow?.last7d ?? 0),
    last7dFailed: Number(statsRow?.last7dFailed ?? 0),
    sparkline,
  };

  const lastSyncSetting =
    (await getSetting(c.env.DB, `workspace:${workspace.id}:last-sync`)) ??
    (await getSetting(c.env.DB, "demo:last-sync"));

  const overview: Overview = {
    workspace,
    stats,
    resources: {
      cloudflare: {
        ...capabilities.providers.cloudflare,
        consoleUrl: `https://dash.cloudflare.com/${workspace.cloudflareAccountId ?? ""}/workers-and-pages`,
        workerCount,
        buildMinutes,
        subdomain: capabilities.providers.cloudflare.workersSubdomain ?? null,
      },
      github: {
        ...capabilities.providers.github,
        rateLimit: githubRate,
      },
      openrouter: {
        ...capabilities.providers.openrouter,
        freeModels: openrouterFree ?? capabilities.providers.openrouter.freeModels ?? null,
      },
      storage: {
        database: "Cloudflare D1",
        deployments: Number(storage?.deployments ?? 0),
        logBytes: Number(storage?.logBytes ?? 0),
        envVars: Number(storage?.envVars ?? 0),
        domains: Number(storage?.domains ?? 0),
      },
    },
    quotas,
    recentDeployments: recentDeployments.map((row) =>
      mapDeployment(row, { name: String(row.project_name), slug: String(row.project_slug) })
    ),
    activities: activityRows.map(mapActivity) as Activity[],
    errors: errorRows.map(mapActivity) as Activity[],
    lastSyncAt: lastSyncSetting ? Number(lastSyncSetting) : null,
    demo: isDemo(c.env),
  };

  return c.json(overview);
});

overviewRoutes.post("/overview/sync", async (c) => {
  const { workspace } = requireAuth(c);
  if (isDemo(c.env)) {
    return c.json({ synced: 0, at: now(), demo: true });
  }
  const synced = await syncActiveDeployments(c.env, workspace.id, 5);
  await setSetting(c.env.DB, `workspace:${workspace.id}:last-sync`, String(now()));
  return c.json({ synced, at: now() });
});

overviewRoutes.get("/activity", async (c) => {
  const { workspace } = requireAuth(c);
  const { page, perPage, offset } = parsePagination(c);
  const level = c.req.query("level") ?? "";
  const projectId = c.req.query("projectId") ?? "";
  const conditions = ["a.workspace_id = ?"];
  const binds: unknown[] = [workspace.id];
  if (["info", "warn", "error", "success"].includes(level)) {
    conditions.push("a.level = ?");
    binds.push(level);
  }
  if (projectId) {
    conditions.push("a.project_id = ?");
    binds.push(projectId);
  }
  const where = conditions.join(" AND ");
  const total = await dbFirst<{ count: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS count FROM activities a WHERE ${where}`,
    ...binds
  );
  const rows = await dbAll<Record<string, any>>(
    c.env.DB,
    `SELECT a.*, p.name AS project_name FROM activities a LEFT JOIN projects p ON p.id = a.project_id
     WHERE ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    ...binds,
    perPage,
    offset
  );
  return c.json({
    items: rows.map(mapActivity),
    total: Number(total?.count ?? 0),
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(Number(total?.count ?? 0) / perPage)),
  });
});

overviewRoutes.get("/audit", async (c) => {
  const { workspace } = requireAuth(c);
  if (!["owner", "admin"].includes(workspace.role)) {
    throw forbidden("Only workspace owners and admins can read the audit log");
  }
  const { page, perPage, offset } = parsePagination(c);
  const rows = await dbAll<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    workspace.id,
    perPage,
    offset
  );
  const total = await dbFirst<{ count: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS count FROM audit_log WHERE workspace_id = ?",
    workspace.id
  );
  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorEmail: row.actor_email,
      targetType: row.target_type,
      targetId: row.target_id,
      createdAt: row.created_at,
      meta: row.meta_json ? JSON.parse(row.meta_json) : null,
    })),
    total: Number(total?.count ?? 0),
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(Number(total?.count ?? 0) / perPage)),
  });
});

overviewRoutes.get("/search", async (c) => {
  const { workspace } = requireAuth(c);
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  if (!q) return c.json({ projects: [], deployments: [], pages: [] });
  const like = `%${q}%`;
  const [projects, deployments] = await Promise.all([
    dbAll<Record<string, any>>(
      c.env.DB,
      `SELECT * FROM projects WHERE workspace_id = ? AND (name LIKE ? OR repo_name LIKE ? OR repo_owner LIKE ?)
       ORDER BY updated_at DESC LIMIT 6`,
      workspace.id,
      like,
      like,
      like
    ),
    dbAll<Record<string, any>>(
      c.env.DB,
      `SELECT d.*, p.name AS project_name, p.slug AS project_slug FROM deployments d
       JOIN projects p ON p.id = d.project_id
       WHERE d.workspace_id = ? AND (d.commit_sha LIKE ? OR d.commit_message LIKE ? OR p.name LIKE ?)
       ORDER BY d.created_at DESC LIMIT 6`,
      workspace.id,
      like,
      like,
      like
    ),
  ]);
  return c.json({
    projects: projects.map(mapProject),
    deployments: deployments.map((row) =>
      mapDeployment(row, { name: String(row.project_name), slug: String(row.project_slug) })
    ),
    pages: [],
  });
});

function buildQuotas(
  buildMinutes: { remaining: number | null; limit: number | null }
): QuotaInfo[] {
  return [
    {
      name: "Workers Builds minutes",
      used:
        buildMinutes.remaining !== null && buildMinutes.limit !== null
          ? Math.max(0, buildMinutes.limit - buildMinutes.remaining)
          : null,
      limit: buildMinutes.limit ?? 3000,
      unit: "minutes / month",
      source: buildMinutes.remaining !== null ? "cloudflare_api" : "cloudflare_docs",
      note:
        buildMinutes.remaining !== null
          ? `${buildMinutes.remaining} minutes reported available by the Cloudflare API.`
          : "Free plan includes 3,000 build minutes/month with 1 concurrent build; paid plans differ. The API may not expose remaining minutes to this token.",
      docsUrl: "https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/",
    },
    {
      name: "Worker requests",
      used: null,
      limit: 100_000,
      unit: "requests / day",
      source: "cloudflare_docs",
      note: "Workers Free limit. Static asset requests are free and unlimited; requests to a Worker count.",
      docsUrl: "https://developers.cloudflare.com/workers/platform/pricing/",
    },
    {
      name: "Worker CPU time",
      used: null,
      limit: 10,
      unit: "ms / invocation",
      source: "cloudflare_docs",
      note: "Workers Free CPU limit. Time spent waiting on I/O does not count.",
      docsUrl: "https://developers.cloudflare.com/workers/platform/limits/",
    },
    {
      name: "Workers Logs",
      used: null,
      limit: 200_000,
      unit: "events / day",
      source: "cloudflare_docs",
      note: "Free plan retention is 3 days. Runtime logs are queried from the Cloudflare Observability API.",
      docsUrl: "https://developers.cloudflare.com/workers/observability/logs/workers-logs/",
    },
    {
      name: "Cloudflare Containers",
      used: null,
      limit: null,
      unit: "paid feature",
      source: "cloudflare_docs",
      note: "Containers require a Workers Paid plan (minimum $5/month). KI00 keeps them disabled and never enables paid resources automatically.",
      docsUrl: "https://developers.cloudflare.com/containers/",
    },
  ];
}
