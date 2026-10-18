import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { loadSession } from "./lib/auth";
import { hashIp } from "./lib/crypto";
import { ApiError } from "./lib/errors";
import { newId, now } from "./lib/utils";

export const requestMeta: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("requestId", newId("req"));
  c.set("user", null);
  c.set("workspace", null);
  c.set("session", null);
  c.set("csrfToken", null);
  c.set("actorEmail", null);
  const ip = clientIp(c);
  c.set("ipHash", await hashIp(ip, c.env.KI00_ENCRYPTION_KEY ?? "ki00-local-ip-salt"));
  await next();
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://avatars.githubusercontent.com https://github.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

/**
 * Applies the same headers to responses Hono generates and to raw Responses
 * proxied from the static-assets binding (which bypass the normal header merge).
 */
export function applySecurityHeaders(headers: Headers, url: URL): Headers {
  const isApi = url.pathname.startsWith("/api/");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  if (isApi) headers.set("Cache-Control", "no-store, max-age=0");
  if (url.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return headers;
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const url = new URL(c.req.url);
  applySecurityHeaders(c.res.headers, url);
  // Keep c.header()-based merging in sync for responses Hono creates after this point.
  const isApi = url.pathname.startsWith("/api/");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  if (isApi) c.header("Cache-Control", "no-store, max-age=0");
  if (url.protocol === "https:") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
};

export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    await next();
    return;
  }
  const origin = c.req.header("origin");
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== new URL(c.req.url).host) {
      throw new ApiError(403, "ORIGIN_REJECTED", "Cross-origin requests are not allowed");
    }
  }
  if (method === "OPTIONS") {
    throw new ApiError(403, "CORS_DISABLED", "CORS is intentionally not enabled");
  }
  await next();
};

export const sessionLoader: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await loadSession(c);
  if (session) {
    c.set("user", session.user);
    c.set("session", session.session);
    c.set("workspace", session.workspace);
    c.set("csrfToken", session.session.csrf_token);
    c.set("actorEmail", session.user.email);
  }
  await next();
};

export function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 80);
  return (
    c.req.header("cf-connecting-ip")?.slice(0, 80) ??
    c.req.header("x-real-ip")?.slice(0, 80) ??
    "local"
  );
}

export function requestTiming(c: Context<AppEnv>): number {
  void c;
  return now();
}
