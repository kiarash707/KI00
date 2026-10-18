import { dbFirst, dbRun } from "./db";
import { now } from "./utils";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter backed by D1. Deliberately simple: it is a guard
 * rail, not a billing meter. Every mutation that costs money or provider quota
 * calls this with a narrow key.
 */
export async function consumeRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const ts = now();
  const windowStart = Math.floor(ts / windowMs) * windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - ts) / 1000));

  await dbRun(
    db,
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start
                    THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start`,
    key,
    windowStart
  );

  const read = await dbFirst<{ count: number }>(
    db,
    "SELECT count FROM rate_limits WHERE key = ?",
    key
  );
  const count = Number(read?.count ?? 1);

  // Opportunistic cleanup keeps the table small without a cron trigger.
  if (Math.random() < 0.02) {
    await dbRun(db, "DELETE FROM rate_limits WHERE window_start < ?", ts - 86_400_000);
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    limit,
    retryAfterSeconds,
  };
}

export function rateLimitKey(parts: (string | number | null | undefined)[]): string {
  return parts.filter((part) => part !== null && part !== undefined).join(":");
}
