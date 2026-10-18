import type { Context } from "hono";
import type { AppEnv } from "../env";
import { dbRun } from "./db";
import { newId, now } from "./utils";

export type ActivityLevel = "info" | "warn" | "error" | "success";

export interface ActivityInput {
  workspaceId: string;
  projectId?: string | null;
  type: string;
  level?: ActivityLevel;
  message: string;
  meta?: Record<string, unknown> | null;
  actor?: string | null;
}

export async function recordActivity(db: D1Database, input: ActivityInput): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO activities (id, workspace_id, project_id, type, level, message, meta_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("act"),
    input.workspaceId,
    input.projectId ?? null,
    input.type,
    input.level ?? "info",
    input.message.slice(0, 600),
    input.meta ? JSON.stringify(input.meta) : null,
    input.actor ?? null,
    now()
  );
}

export interface AuditInput {
  workspaceId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Append-only audit record for every mutating action. Never includes secret values. */
export async function recordAudit(c: Context<AppEnv>, input: AuditInput): Promise<void> {
  const user = c.get("user");
  await dbRun(
    c.env.DB,
    `INSERT INTO audit_log (id, workspace_id, actor_id, actor_email, action, target_type, target_id, ip_hash, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("aud"),
    input.workspaceId,
    user?.id ?? null,
    user?.email ?? null,
    input.action.slice(0, 120),
    input.targetType ?? null,
    input.targetId ?? null,
    c.get("ipHash") ?? null,
    input.meta ? JSON.stringify(input.meta).slice(0, 4000) : null,
    now()
  );
}
