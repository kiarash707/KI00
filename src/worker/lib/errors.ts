import type { Context } from "hono";
import type { ZodError } from "zod";
import { now } from "./utils";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { hint?: string; details?: unknown } = {}
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export class ProviderError extends ApiError {
  readonly provider: "cloudflare" | "github" | "openrouter";

  constructor(
    provider: "cloudflare" | "github" | "openrouter",
    status: number,
    message: string,
    options: { hint?: string; code?: string; details?: unknown } = {}
  ) {
    super(status, options.code ?? `${provider.toUpperCase()}_ERROR`, message, options);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "BAD_REQUEST", message, details ? { details } : {});
export const unauthorized = (message = "Authentication required") =>
  new ApiError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to do that") =>
  new ApiError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found") => new ApiError(404, "NOT_FOUND", message);
export const conflict = (message: string, hint?: string) =>
  new ApiError(409, "CONFLICT", message, hint ? { hint } : {});
export const tooMany = (message = "Too many requests", hint?: string) =>
  new ApiError(429, "RATE_LIMITED", message, hint ? { hint } : {});
export const notConfigured = (provider: string, hint: string) =>
  new ApiError(424, "NOT_CONFIGURED", `${provider} is not configured`, { hint });

export function zodDetails(error: ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 12).map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function formatZodError(error: ZodError): ApiError {
  const details = zodDetails(error);
  const first = details[0];
  return new ApiError(
    400,
    "VALIDATION_ERROR",
    first ? `${first.path || "input"}: ${first.message}` : "Invalid input",
    { details }
  );
}

export function errorResponse(c: Context, error: unknown): Response {
  const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
  if (error instanceof ApiError) {
    const body = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
        requestId,
      },
    };
    return c.json(body, error.status as 400);
  }

  console.error(
    JSON.stringify({
      level: "error",
      event: "unhandled_error",
      requestId,
      at: now(),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 2000) : undefined,
    })
  );
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        hint: "Check the Worker logs for the request id above.",
        requestId,
      },
    },
    500
  );
}
