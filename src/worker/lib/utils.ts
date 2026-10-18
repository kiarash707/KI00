const ID_ALPHABET = "0123456789abcdef";

export function now(): number {
  return Date.now();
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % 16];
  return `${prefix}_${out}`;
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function toInt(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function clampString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function slugify(input: string, max = 46): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "project";
}

/** Cloudflare Worker names: lowercase alphanumeric and hyphens, max 54 chars. */
export function workerNameFor(slug: string): string {
  const base = `ki00-${slug}`.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 54);
  return base.replace(/-+$/g, "");
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function firstLine(value: string, max = 240): string {
  const line = value.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return truncate(line.trim(), max);
}

export function msToIso(value: number | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

export function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) {
    // Still perform a comparison to keep timing roughly constant.
    let diff = 1;
    const len = Math.max(ab.length, bb.length);
    for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
    void diff;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonBody(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function escapeShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join("[REDACTED]");
  }
  return out
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(sk-or-v1-[A-Za-z0-9-]{16,})\b/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/\b(sk-[A-Za-z0-9]{20,})\b/g, "[REDACTED_KEY]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}
