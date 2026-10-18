export interface ApiErrorBody {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
  requestId?: string;
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = body.code;
    this.hint = body.hint;
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

let csrfToken: string | null = null;
let workspaceId: string | null = null;

/** CSRF tokens live in memory only; never in localStorage or the URL. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function setWorkspaceId(id: string | null): void {
  workspaceId = id;
}

export function getWorkspaceId(): string | null {
  return workspaceId;
}

function headers(extra?: HeadersInit): Headers {
  const result = new Headers(extra);
  if (!result.has("content-type")) result.set("content-type", "application/json");
  if (csrfToken) result.set("x-ki00-csrf", csrfToken);
  if (workspaceId) result.set("x-ki00-workspace", workspaceId);
  return result;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: headers(init.headers),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const body = (payload as { error?: ApiErrorBody } | null)?.error;
    throw new ApiRequestError(
      response.status,
      body ?? {
        code: "NETWORK_ERROR",
        message: `Request failed with status ${response.status}. The server did not return a JSON error.`,
      }
    );
  }
  return payload as T;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function del<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong. Check your connection and try again.";
}

export interface StreamHandlers {
  onEvent: (event: unknown) => void;
  onError: (error: Error) => void;
  onDone: () => void;
  signal?: AbortSignal;
}

/** Streams newline-delimited JSON events from the agent endpoint. */
export async function streamAgent(body: unknown, handlers: StreamHandlers): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/agent/run", {
      method: "POST",
      credentials: "same-origin",
      headers: headers(),
      body: JSON.stringify(body),
      signal: handlers.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      handlers.onDone();
      return;
    }
    handlers.onError(error instanceof Error ? error : new Error("Network error"));
    return;
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let parsed: { error?: ApiErrorBody } | null = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    handlers.onError(
      new ApiRequestError(
        response.status,
        parsed?.error ?? { code: "AGENT_ERROR", message: `The agent request failed (${response.status}).` }
      )
    );
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handlers.onEvent(JSON.parse(trimmed));
        } catch {
          /* skip malformed event */
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        handlers.onEvent(JSON.parse(tail));
      } catch {
        /* ignore */
      }
    }
    handlers.onDone();
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      handlers.onDone();
      return;
    }
    handlers.onError(error instanceof Error ? error : new Error("Streaming failed"));
  }
}
