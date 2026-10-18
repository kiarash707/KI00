import { Hono } from "hono";
import type { AppEnv } from "../env";
import { buildSessionInfo } from "../lib/session-info";
import { getCapabilities, isDemo, invalidateProviderStatus } from "../lib/providers";
import {
  countUsers,
  createSession,
  destroySession,
  requireCsrf,
} from "../lib/auth";
import { ApiError, formatZodError, tooMany } from "../lib/errors";
import { loginSchema, setupSchema } from "../lib/validation";
import { constantTimeEqual, hashPassword, verifyPassword } from "../lib/crypto";
import { dbFirst, dbRun, setSetting } from "../lib/db";
import { newId, now, slugify } from "../lib/utils";
import { recordActivity, recordAudit } from "../lib/activity";
import { consumeRateLimit, rateLimitKey } from "../lib/rate-limit";
import { clientIp } from "../middleware";
import { ensureDemoSeed, DEMO_PASSWORD } from "../lib/demo";
import { CloudflareClient } from "../lib/cloudflare";

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/auth/session", async (c) => {
  return c.json(await buildSessionInfo(c));
});

authRoutes.get("/bootstrap", async (c) => {
  return c.json(await getCapabilities(c.env));
});

authRoutes.post("/auth/setup", async (c) => {
  const users = await countUsers(c.env.DB);
  if (users > 0) {
    throw new ApiError(409, "SETUP_COMPLETE", "KI00 has already been set up. Sign in instead.");
  }
  if (!c.env.KI00_SETUP_TOKEN) {
    throw new ApiError(503, "SETUP_TOKEN_MISSING", "KI00_SETUP_TOKEN is not configured", {
      hint: "Generate a long random value and add it with: npx wrangler secret put KI00_SETUP_TOKEN",
    });
  }
  if (!c.env.KI00_ENCRYPTION_KEY) {
    throw new ApiError(503, "ENCRYPTION_KEY_MISSING", "KI00_ENCRYPTION_KEY is not configured", {
      hint: "Project environment values are encrypted at rest. Add a 32-byte base64 key with: npx wrangler secret put KI00_ENCRYPTION_KEY",
    });
  }

  const limited = await consumeRateLimit(
    c.env.DB,
    rateLimitKey(["setup", c.get("ipHash")]),
    5,
    60 * 60 * 1000
  );
  if (!limited.allowed) throw tooMany("Too many setup attempts", "Wait and try again.");

  const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  const body = parsed.data;
  if (!constantTimeEqual(body.setupToken, c.env.KI00_SETUP_TOKEN)) {
    throw new ApiError(403, "SETUP_TOKEN_INVALID", "The setup token is incorrect");
  }

  const ts = now();
  const userId = newId("usr");
  const workspaceId = newId("wsp");
  const password = await hashPassword(body.password);
  const workspaceName = body.workspaceName?.trim() || "KI00 Workspace";
  const slug = `${slugify(workspaceName, 40)}-${workspaceId.slice(-4)}`;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'owner', ?)`
    ).bind(userId, body.email, body.name, password.hash, password.salt, password.iterations, ts),
    c.env.DB.prepare(
      `INSERT INTO workspaces (id, name, slug, cloudflare_account_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      workspaceId,
      workspaceName,
      slug,
      c.env.CLOUDFLARE_ACCOUNT_ID ?? c.env.KI00_DEFAULT_ACCOUNT_ID ?? null,
      userId,
      ts,
      ts
    ),
    c.env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)"
    ).bind(workspaceId, userId, ts),
  ]);

  // Best-effort account discovery/verification; setup still succeeds if Cloudflare is offline.
  if (c.env.CLOUDFLARE_API_TOKEN) {
    try {
      const client = new CloudflareClient({
        token: c.env.CLOUDFLARE_API_TOKEN,
        accountId: c.env.CLOUDFLARE_ACCOUNT_ID ?? null,
      });
      await client.verifyToken();
      let accountId = c.env.CLOUDFLARE_ACCOUNT_ID ?? null;
      let accountName: string | null = null;
      if (!accountId) {
        const accounts = await client.listAccounts();
        accountId = accounts[0]?.id ?? null;
        accountName = accounts[0]?.name ?? null;
      }
      if (accountId) {
        await dbRun(
          c.env.DB,
          "UPDATE workspaces SET cloudflare_account_id = ?, cloudflare_account_name = ?, updated_at = ? WHERE id = ?",
          accountId,
          accountName,
          now(),
          workspaceId
        );
        if (accountName) await setSetting(c.env.DB, `cf:account-name:${accountId}`, accountName);
      }
      await invalidateProviderStatus(c.env);
    } catch {
      /* surfaced on the Connections page */
    }
  }

  await createSession(c, userId);
  c.set("user", { id: userId, email: body.email, name: body.name, role: "owner" });
  c.set("workspace", {
    id: workspaceId,
    name: workspaceName,
    slug,
    cloudflareAccountId: c.env.CLOUDFLARE_ACCOUNT_ID ?? null,
    cloudflareAccountName: null,
    role: "owner",
    createdAt: ts,
  });
  // Reload the session so CSRF and workspace are bound for the response.
  const refreshed = await buildSessionInfo(c);
  await recordAudit(c, {
    workspaceId,
    action: "workspace.setup",
    targetType: "workspace",
    targetId: workspaceId,
    meta: { email: body.email },
  });
  await recordActivity(c.env.DB, {
    workspaceId,
    type: "workspace.setup",
    level: "success",
    message: "Workspace created and owner account configured.",
    actor: body.email,
  });

  return c.json(refreshed, 201);
});

authRoutes.post("/auth/login", async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  const { email, password } = parsed.data;

  const limited = await consumeRateLimit(
    c.env.DB,
    rateLimitKey(["login", c.get("ipHash"), email]),
    8,
    15 * 60 * 1000
  );
  if (!limited.allowed) {
    throw tooMany("Too many sign-in attempts", "Try again in a few minutes.");
  }

  const user = await dbFirst<{
    id: string;
    email: string;
    name: string;
    password_hash: string;
    password_salt: string;
    password_iterations: number;
    role: string;
  }>(c.env.DB, "SELECT * FROM users WHERE email = ?", email);
  if (!user) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  const valid = await verifyPassword(
    password,
    user.password_hash,
    user.password_salt,
    user.password_iterations
  );
  if (!valid) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }

  await createSession(c, user.id);
  await dbRun(c.env.DB, "UPDATE users SET last_login_at = ? WHERE id = ?", now(), user.id);
  c.set("user", {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });
  const session = await buildSessionInfo(c);
  return c.json(session);
});

authRoutes.post("/auth/demo", async (c) => {
  if (!isDemo(c.env)) {
    throw new ApiError(404, "NOT_FOUND", "Not found");
  }
  const identity = await ensureDemoSeed(c.env);
  const user = await dbFirst<{ id: string; email: string; name: string; role: string }>(
    c.env.DB,
    "SELECT id, email, name, role FROM users WHERE id = ?",
    identity.userId
  );
  if (!user) throw new ApiError(500, "DEMO_SEED_FAILED", "Demo workspace could not be created");
  await createSession(c, user.id);
  c.set("user", user);
  const demoWorkspace = await dbFirst<{
    id: string;
    name: string;
    slug: string;
    cloudflare_account_id: string | null;
    cloudflare_account_name: string | null;
    role: string;
    created_at: number;
  }>(
    c.env.DB,
    `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
     WHERE w.id = ? AND m.user_id = ?`,
    identity.workspaceId,
    user.id
  );
  if (demoWorkspace) {
    c.set("workspace", {
      id: demoWorkspace.id,
      name: demoWorkspace.name,
      slug: demoWorkspace.slug,
      cloudflareAccountId: demoWorkspace.cloudflare_account_id,
      cloudflareAccountName: demoWorkspace.cloudflare_account_name,
      role: demoWorkspace.role,
      createdAt: demoWorkspace.created_at,
    });
  }
  const payload = await buildSessionInfo(c);
  return c.json({ ...payload, demoPassword: DEMO_PASSWORD });
});

authRoutes.post("/auth/logout", async (c) => {
  requireCsrf(c);
  await destroySession(c);
  return c.json({ ok: true });
});

authRoutes.post("/auth/logout-all", async (c) => {
  requireCsrf(c);
  const user = c.get("user");
  if (user) await dbRun(c.env.DB, "DELETE FROM sessions WHERE user_id = ?", user.id);
  await destroySession(c);
  return c.json({ ok: true });
});

// Keep clientIp referenced for future audit enrichment without dead-code lint noise.
void clientIp;
