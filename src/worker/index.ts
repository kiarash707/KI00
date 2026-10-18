import { Hono } from "hono";
import type { AppEnv } from "./env";
import { APP_VERSION } from "./env";
import { errorResponse } from "./lib/errors";
import { requireCsrf } from "./lib/auth";
import { requestMeta, securityHeaders, originGuard, sessionLoader, applySecurityHeaders } from "./middleware";
import { authRoutes } from "./routes/auth";
import { githubRoutes } from "./routes/github";
import { projectRoutes } from "./routes/projects";
import { deploymentRoutes } from "./routes/deployments";
import { overviewRoutes } from "./routes/overview";
import { settingsRoutes } from "./routes/settings";
import { agentRoutes } from "./routes/agent";
import { now } from "./lib/utils";

const app = new Hono<AppEnv>();

app.use("*", requestMeta);
app.use("*", securityHeaders);
app.use("*", originGuard);
app.use("*", sessionLoader);

app.get("/health", (c) =>
  c.json({
    ok: true,
    name: c.env.KI00_APP_NAME ?? "KI00",
    version: APP_VERSION,
    env: c.env.KI00_ENV ?? "production",
    demo: c.env.KI00_DEMO === "1",
    time: now(),
  })
);

const api = new Hono<AppEnv>();

// CSRF defence for every authenticated mutation. SameSite=Strict cookies plus the
// origin guard already block cross-site requests; this binds requests to the session token.
api.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (!c.get("session")) return next();
  const path = new URL(c.req.url).pathname;
  const unauthenticated = ["/api/auth/login", "/api/auth/setup", "/api/auth/demo"];
  if (unauthenticated.includes(path)) return next();
  requireCsrf(c);
  await next();
});

api.route("/", authRoutes);
api.route("/", githubRoutes);
api.route("/", projectRoutes);
api.route("/", deploymentRoutes);
api.route("/", overviewRoutes);
api.route("/", settingsRoutes);
api.route("/", agentRoutes);

api.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "API route not found" }, requestId: c.get("requestId") }, 404)
);

app.route("/api", api);

app.notFound(async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
    return c.json({ error: { code: "NOT_FOUND", message: "API route not found" } }, 404);
  }
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const headers = applySecurityHeaders(new Headers(response.headers), url);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});

app.onError((error, c) => errorResponse(c, error));

export default app;
