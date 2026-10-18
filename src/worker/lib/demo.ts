import type { Env } from "../env";
import { dbFirst, dbRun, getSetting, setSetting } from "./db";
import { hashPassword, encryptValue } from "./crypto";
import { newId, now } from "./utils";

/**
 * Local preview only. Demo mode is opt-in (KI00_DEMO=1), disabled in the
 * production Wrangler config, and every record is labelled as sample data in
 * the dashboard. Demo routes never call Cloudflare, GitHub or OpenRouter and
 * never fabricate build logs.
 */

const DEMO_EMAIL = "demo@ki00.local";
export const DEMO_PASSWORD = "ki00-demo-local";

export interface DemoIdentity {
  userId: string;
  workspaceId: string;
}

export async function ensureDemoSeed(env: Env): Promise<DemoIdentity> {
  const existing = await getSetting(env.DB, "demo:identity");
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as DemoIdentity;
      if (parsed.userId && parsed.workspaceId) return parsed;
    } catch {
      /* re-seed below */
    }
  }

  const ts = now();
  const user = await dbFirst<{ id: string }>(
    env.DB,
    "SELECT id FROM users WHERE email = ?",
    DEMO_EMAIL
  );
  let userId = user?.id;
  if (!userId) {
    userId = newId("usr");
    const password = await hashPassword(DEMO_PASSWORD);
    await dbRun(
      env.DB,
      `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'owner', ?)`,
      userId,
      DEMO_EMAIL,
      "Demo Admin",
      password.hash,
      password.salt,
      password.iterations,
      ts
    );
  }

  const workspace = await dbFirst<{ id: string }>(
    env.DB,
    "SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? LIMIT 1",
    userId
  );
  let workspaceId = workspace?.id;
  if (!workspaceId) {
    workspaceId = newId("wsp");
    await dbRun(
      env.DB,
      `INSERT INTO workspaces (id, name, slug, cloudflare_account_id, cloudflare_account_name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      workspaceId,
      "KI00 Demo Workspace",
      "ki00-demo",
      "Demo Account (sample)",
      userId,
      ts,
      ts
    );
    await dbRun(
      env.DB,
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      workspaceId,
      userId,
      ts
    );
  }

  const demoProjectCount = await dbFirst<{ count: number }>(
    env.DB,
    "SELECT COUNT(*) AS count FROM projects WHERE workspace_id = ?",
    workspaceId
  );
  if (Number(demoProjectCount?.count ?? 0) === 0) {
    await seedProjects(env, workspaceId, userId, ts);
  }

  const identity = { userId, workspaceId };
  await setSetting(env.DB, "demo:identity", JSON.stringify(identity));
  await setSetting(env.DB, "demo:seeded", "1");
  return identity;
}

export async function findDemoIdentity(env: Env): Promise<DemoIdentity | null> {
  const raw = await getSetting(env.DB, "demo:identity");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DemoIdentity;
    return parsed.userId && parsed.workspaceId ? parsed : null;
  } catch {
    return null;
  }
}

async function seedProjects(env: Env, workspaceId: string, userId: string, baseTime: number) {
  const projects = [
    {
      id: newId("prj"),
      name: "ki00-docs",
      slug: "ki00-docs",
      repo: ["kiarash707", "ki00-docs"],
      framework: "Astro",
      language: "TypeScript",
      runtime: "static" as const,
      runtimeDetail: "Workers Static Assets",
      type: "Astro static site",
      build: "npm run build",
      output: "dist",
      status: "active",
      buildStatus: "success",
      url: "https://ki00-docs.ki00-demo.workers.dev",
      hoursAgo: 3,
      spa: false,
      description: "Documentation site deployed as Cloudflare Workers static assets.",
    },
    {
      id: newId("prj"),
      name: "edge-api",
      slug: "edge-api",
      repo: ["kiarash707", "edge-api"],
      framework: "Hono",
      language: "TypeScript",
      runtime: "worker" as const,
      runtimeDetail: "Cloudflare Workers",
      type: "Hono API on Workers",
      build: "npm run build",
      output: "dist",
      status: "active",
      buildStatus: "success",
      url: "https://edge-api.ki00-demo.workers.dev",
      hoursAgo: 26,
      spa: false,
      description: "Fetch-native API with a D1 binding, deployed as a Worker.",
    },
    {
      id: newId("prj"),
      name: "acme-storefront",
      slug: "acme-storefront",
      repo: ["kiarash707", "acme-storefront"],
      framework: "Vite + React",
      language: "TypeScript",
      runtime: "static" as const,
      runtimeDetail: "Workers Static Assets",
      type: "Single-page application",
      build: "npm run build",
      output: "dist",
      status: "error",
      buildStatus: "failed",
      url: "https://acme-storefront.ki00-demo.workers.dev",
      hoursAgo: 9,
      spa: true,
      description: "Storefront SPA with an intentionally failing sample build.",
    },
  ];

  for (const project of projects) {
    const created = baseTime - project.hoursAgo * 3_600_000 - 86_400_000;
    await dbRun(
      env.DB,
      `INSERT INTO projects (
        id, workspace_id, name, slug, description, repo_owner, repo_name, repo_id, repo_private,
        default_branch, branch, project_type, framework, language, runtime_kind, runtime_detail,
        compatibility_status, compatibility_notes, build_command, install_command, output_dir, root_dir,
        deploy_command, worker_name, worker_tag, workers_dev_url, spa_fallback, auto_deploy, build_caching,
        has_wrangler_config, wrangler_has_routes,
        status, detected_env_keys, detection_json, last_build_status, last_build_finished_at,
        last_deployed_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project.id,
      workspaceId,
      project.name,
      project.slug,
      project.description,
      project.repo[0],
      project.repo[1],
      "1000",
      0,
      "main",
      "main",
      project.type,
      project.framework,
      project.language,
      project.runtime,
      project.runtimeDetail,
      "compatible",
      "[]",
      project.build,
      "npm ci",
      project.output,
      "/",
      "",
      `ki00-${project.slug}`,
      null,
      project.url,
      project.spa ? 1 : 0,
      1,
      1,
      project.status,
      null,
      null,
      project.buildStatus,
      baseTime - project.hoursAgo * 3_600_000,
      project.buildStatus === "success" ? baseTime - project.hoursAgo * 3_600_000 : null,
      userId,
      created,
      baseTime - project.hoursAgo * 3_600_000
    );

    const sha = Array.from({ length: 40 }, (_, index) =>
      "0123456789abcdef"[(index * 7 + project.name.length) % 16]
    ).join("");
    const failed = project.status === "error";
    const deploymentId = newId("dep");
    const finished = baseTime - project.hoursAgo * 3_600_000;
    await dbRun(
      env.DB,
      `INSERT INTO deployments (
        id, workspace_id, project_id, provider, trigger_kind, build_uuid, status, outcome, branch,
        commit_sha, commit_message, author, url, preview_url, error_summary, created_at, started_at,
        finished_at, duration_ms, updated_at, requested_by
      ) VALUES (?, ?, ?, 'demo', 'production', NULL, ?, ?, 'main', ?, ?, 'Demo Admin', ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      deploymentId,
      workspaceId,
      project.id,
      failed ? "failed" : "success",
      failed ? "fail" : "success",
      sha,
      failed ? "chore: update dependencies" : "feat: refresh landing page",
      failed ? null : project.url,
      failed ? "vite build exited with code 1" : null,
      finished - 80_000,
      finished - 80_000,
      finished,
      80_000,
      finished,
      userId
    );
    await dbRun(
      env.DB,
      `UPDATE projects SET last_deployment_id = ?, last_build_status = ?, last_build_finished_at = ?,
       last_deployed_at = ?, updated_at = ? WHERE id = ?`,
      deploymentId,
      failed ? "failed" : "success",
      finished,
      failed ? null : finished,
      finished,
      project.id
    );
  }

  const docs = projects[0]!;
  const api = projects[1]!;
  for (const [project, key, value, runtime] of [
    [docs, "PUBLIC_SITE_URL", "https://docs.example.com", 0],
    [api, "API_BASE_URL", "https://api.example.com", 1],
    [api, "SESSION_SIGNING_KEY", "demo-value-not-a-real-secret", 1],
  ] as const) {
    const encrypted = await encryptValue(value, env.KI00_ENCRYPTION_KEY);
    await dbRun(
      env.DB,
      `INSERT INTO env_vars (id, project_id, key, value_enc, is_secret, scope, use_build, use_runtime, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'production', 1, ?, ?, ?)`,
      newId("env"),
      project.id,
      key,
      encrypted,
      runtime,
      baseTime - 48 * 3_600_000,
      baseTime - 48 * 3_600_000
    );
  }

  await dbRun(
    env.DB,
    `INSERT INTO domains (id, project_id, hostname, zone_id, zone_name, cloudflare_domain_id, status, dns_instructions, created_at, verified_at)
     VALUES (?, ?, 'docs.ki00-demo.dev', NULL, 'ki00-demo.dev', NULL, 'instructions', ?, ?, NULL)`,
    newId("dom"),
    docs.id,
    "Add docs.ki00-demo.dev as a Custom Domain from Workers & Pages → your Worker → Settings → Domains & Routes. The zone must be active in the same Cloudflare account.",
    baseTime - 40 * 3_600_000
  );

  const activities = [
    [docs.id, "deploy.success", "success", "Deployed ki00-docs from commit 4a7c1e9", 3],
    [api.id, "deploy.success", "success", "Deployed edge-api from commit 9f2b01c", 26],
    [projects[2]!.id, "deploy.failed", "error", "acme-storefront build failed: vite build exited with code 1", 9],
    [null, "workspace.demo", "info", "Demo workspace created. No Cloudflare or GitHub calls are made.", 48],
  ] as const;
  for (const [projectId, type, level, message, hoursAgo] of activities) {
    await dbRun(
      env.DB,
      `INSERT INTO activities (id, workspace_id, project_id, type, level, message, meta_json, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'Demo Admin', ?)`,
      newId("act"),
      workspaceId,
      projectId,
      type,
      level,
      message,
      baseTime - hoursAgo * 3_600_000
    );
  }

  await setSetting(env.DB, "demo:last-sync", String(baseTime));
}
