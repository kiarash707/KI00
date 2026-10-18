import { now } from "./utils";

export type Row = Record<string, unknown>;

export async function dbFirst<T = Row>(
  db: D1Database,
  sql: string,
  ...bindings: unknown[]
): Promise<T | null> {
  const stmt = db.prepare(sql);
  const prepared = bindings.length ? stmt.bind(...bindings) : stmt;
  return (await prepared.first<T>()) ?? null;
}

export async function dbAll<T = Row>(
  db: D1Database,
  sql: string,
  ...bindings: unknown[]
): Promise<T[]> {
  const stmt = db.prepare(sql);
  const prepared = bindings.length ? stmt.bind(...bindings) : stmt;
  const result = await prepared.all<T>();
  return result.results ?? [];
}

export async function dbRun(
  db: D1Database,
  sql: string,
  ...bindings: unknown[]
): Promise<D1Result> {
  const stmt = db.prepare(sql);
  const prepared = bindings.length ? stmt.bind(...bindings) : stmt;
  return prepared.run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await dbFirst<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE key = ?",
    key
  );
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    now()
  );
}

export async function getSettings(
  db: D1Database,
  keys: string[]
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const placeholders = keys.map(() => "?").join(",");
  const rows = await dbAll<{ key: string; value: string }>(
    db,
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
    ...keys
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  await dbRun(db, "DELETE FROM settings WHERE key = ?", key);
}

export function pageParams(
  pageRaw: string | undefined,
  perPageRaw: string | undefined,
  maxPerPage = 100
): { page: number; perPage: number; offset: number } {
  const page = Math.max(1, Number.parseInt(pageRaw ?? "1", 10) || 1);
  const perPage = Math.min(maxPerPage, Math.max(1, Number.parseInt(perPageRaw ?? "20", 10) || 20));
  return { page, perPage, offset: (page - 1) * perPage };
}

export async function countRows(
  db: D1Database,
  sql: string,
  ...bindings: unknown[]
): Promise<number> {
  const row = await dbFirst<{ count: number }>(db, sql, ...bindings);
  return Number(row?.count ?? 0);
}
