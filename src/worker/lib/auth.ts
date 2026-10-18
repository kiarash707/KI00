import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, SessionRow } from "../env";
import type { User, Workspace } from "../../shared/types";
import { dbAll, dbFirst, dbRun } from "./db";
import { ApiError, forbidden, unauthorized } from "./errors";
import { hashIp, randomToken, sha256Hex } from "./crypto";
import { now, safeEqual } from "./utils";

export const SESSION_COOKIE = "ki00_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

export function isSecureRequest(c: Context<AppEnv>): boolean {
  const url = new URL(c.req.url);
  return url.protocol === "https:";
}

export async function createSession(
  c: Context<AppEnv>,
  userId: string
): Promise<{ token: string; csrfToken: string; expiresAt: number }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const tokenHash = await sha256Hex(token);
  const ts = now();
  const expiresAt = ts + SESSION_TTL_MS;
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "local";
  const ipHash = await hashIp(ip, c.env.KI00_ENCRYPTION_KEY ?? "ki00-unsalted");
  const userAgent = (c.req.header("user-agent") ?? "").slice(0, 240);

  await dbRun(
    c.env.DB,
    `INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    tokenHash,
    userId,
    csrfToken,
    ts,
    ts,
    expiresAt,
    ipHash,
    userAgent
  );

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  // Expose the freshly created session to the current request so login/setup/demo
  // responses include the CSRF token without a second database round-trip.
  c.set("session", {
    token_hash: tokenHash,
    user_id: userId,
    csrf_token: csrfToken,
    created_at: ts,
    last_seen_at: ts,
    expires_at: expiresAt,
    ip_hash: ipHash,
    user_agent: userAgent,
  });
  c.set("csrfToken", csrfToken);

  return { token, csrfToken, expiresAt };
}

export async function loadSession(
  c: Context<AppEnv>
): Promise<{ user: User; session: SessionRow; workspace: Workspace | null } | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const tokenHash = await sha256Hex(token);
  const row = await dbFirst<
    SessionRow & { email: string; name: string; user_role: string }
  >(
    c.env.DB,
    `SELECT s.*, u.email AS email, u.name AS name, u.role AS user_role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    tokenHash
  );
  if (!row) return null;
  const ts = now();
  if (row.expires_at <= ts || row.created_at + 30 * 24 * 60 * 60 * 1000 <= ts) {
    await dbRun(c.env.DB, "DELETE FROM sessions WHERE token_hash = ?", tokenHash);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return null;
  }

  if (ts - row.last_seen_at > 5 * 60 * 1000) {
    await dbRun(
      c.env.DB,
      "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
      ts,
      Math.min(ts + SESSION_TTL_MS, row.created_at + 30 * 24 * 60 * 60 * 1000),
      tokenHash
    );
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isSecureRequest(c),
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  }

  const workspace = await resolveWorkspace(c, row.user_id);
  return {
    user: { id: row.user_id, email: row.email, name: row.name, role: row.user_role },
    session: row,
    workspace,
  };
}

export async function resolveWorkspace(
  c: Context<AppEnv>,
  userId: string
): Promise<Workspace | null> {
  const requested = c.req.header("x-ki00-workspace");
  const rows = await dbAll<{
    id: string;
    name: string;
    slug: string;
    cloudflare_account_id: string | null;
    cloudflare_account_name: string | null;
    role: string;
    created_at: number;
  }>(
    c.env.DB,
    `SELECT w.id, w.name, w.slug, w.cloudflare_account_id, w.cloudflare_account_name, m.role, w.created_at
     FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
     WHERE m.user_id = ?
     ORDER BY w.created_at ASC`,
    userId
  );
  if (rows.length === 0) return null;
  const chosen = requested ? rows.find((row) => row.id === requested) : rows[0];
  if (requested && !chosen) throw forbidden("You are not a member of that workspace");
  const row = chosen!;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    cloudflareAccountId: row.cloudflare_account_id,
    cloudflareAccountName: row.cloudflare_account_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

export async function listWorkspaces(c: Context<AppEnv>, userId: string): Promise<Workspace[]> {
  const rows = await dbAll<{
    id: string;
    name: string;
    slug: string;
    cloudflare_account_id: string | null;
    cloudflare_account_name: string | null;
    role: string;
    created_at: number;
  }>(
    c.env.DB,
    `SELECT w.id, w.name, w.slug, w.cloudflare_account_id, w.cloudflare_account_name, m.role, w.created_at
     FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
     WHERE m.user_id = ? ORDER BY w.created_at ASC`,
    userId
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    cloudflareAccountId: row.cloudflare_account_id,
    cloudflareAccountName: row.cloudflare_account_name,
    role: row.role,
    createdAt: row.created_at,
  }));
}

export function requireAuth(c: Context<AppEnv>): {
  user: User;
  workspace: Workspace;
  session: SessionRow;
} {
  const user = c.get("user");
  const workspace = c.get("workspace");
  const session = c.get("session");
  if (!user || !session) throw unauthorized();
  if (!workspace) throw new ApiError(409, "NO_WORKSPACE", "No workspace is available for this account");
  return { user, workspace, session };
}

export function requireCsrf(c: Context<AppEnv>): void {
  const session = c.get("session");
  if (!session) throw unauthorized();
  const header = c.req.header("x-ki00-csrf");
  if (!header || !safeEqual(header, session.csrf_token)) {
    throw new ApiError(403, "CSRF_FAILED", "Missing or invalid CSRF token");
  }
}

export function requireOwner(c: Context<AppEnv>): void {
  const { workspace } = requireAuth(c);
  if (workspace.role !== "owner" && workspace.role !== "admin" && workspace.role !== "member") {
    throw forbidden("This action requires workspace admin access");
  }
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await dbRun(c.env.DB, "DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await dbFirst<{ count: number }>(db, "SELECT COUNT(*) AS count FROM users");
  return Number(row?.count ?? 0);
}

export async function pruneSessions(db: D1Database): Promise<void> {
  await dbRun(db, "DELETE FROM sessions WHERE expires_at <= ?", now());
}
