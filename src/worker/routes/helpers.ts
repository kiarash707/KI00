import type { Context } from "hono";
import type { AppEnv } from "../env";
import { isDemo } from "../lib/providers";
import { ApiError, tooMany } from "../lib/errors";
import { consumeRateLimit, rateLimitKey } from "../lib/rate-limit";
import { dbFirst } from "../lib/db";

export async function assertWritable(c: Context<AppEnv>): Promise<void> {
  if (isDemo(c.env)) {
    throw new ApiError(409, "DEMO_READ_ONLY", "This is a demo workspace", {
      hint: "Demo data is sample-only. Connect Cloudflare, GitHub and OpenRouter secrets to use write operations.",
    });
  }
}

export async function enforceRateLimit(
  c: Context<AppEnv>,
  key: string,
  limit: number,
  windowMs: number
): Promise<void> {
  const result = await consumeRateLimit(c.env.DB, key, limit, windowMs);
  if (!result.allowed) {
    throw tooMany(
      `Rate limit reached (${limit} per ${Math.round(windowMs / 60000)} minutes)`,
      `Try again in about ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`
    );
  }
}

export function workspaceLimitKey(c: Context<AppEnv>, action: string): string {
  const workspace = c.get("workspace");
  const user = c.get("user");
  return rateLimitKey([action, workspace?.id, user?.id]);
}

export function parsePagination(c: Context<AppEnv>): {
  page: number;
  perPage: number;
  offset: number;
} {
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  const perPage = Math.min(
    100,
    Math.max(1, Number.parseInt(c.req.query("perPage") ?? "20", 10) || 20)
  );
  return { page, perPage, offset: (page - 1) * perPage };
}

export async function loadProjectOr404(
  c: Context<AppEnv>,
  projectId: string
): Promise<Record<string, any>> {
  const workspace = c.get("workspace");
  const row = await dbFirst<Record<string, any>>(
    c.env.DB,
    "SELECT * FROM projects WHERE id = ? AND workspace_id = ?",
    projectId,
    workspace?.id
  );
  if (!row) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
  return row;
}

export function boolInt(value: unknown): number {
  return value === true ? 1 : 0;
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
