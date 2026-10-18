import type { FreeModel } from "../../shared/types";
import { ProviderError } from "./errors";
import { fetchWithTimeout, parseRetryAfter, sleep } from "./http";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

interface RawModel {
  id?: string;
  name?: string;
  created?: number;
  description?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: Record<string, string | undefined>;
  supported_parameters?: string[];
  top_provider?: { context_length?: number; max_completion_tokens?: number; is_moderated?: boolean };
}

interface RawCatalog {
  data?: RawModel[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export class OpenRouterClient {
  private readonly apiKey: string;

  constructor(apiKey: string, private readonly baseUrl = OPENROUTER_BASE) {
    this.apiKey = apiKey;
  }

  static fromEnv(env: { OPENROUTER_API_KEY?: string }): OpenRouterClient {
    const key = env.OPENROUTER_API_KEY?.trim();
    if (!key) {
      throw new ProviderError("openrouter", 424, "OpenRouter is not configured", {
        code: "OPENROUTER_NOT_CONFIGURED",
        hint: "Set the OPENROUTER_API_KEY Worker secret. The key is only read server-side.",
      });
    }
    return new OpenRouterClient(key);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: { retries?: number; timeoutMs?: number } = {}
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const retries = options.retries ?? (method === "GET" ? 1 : 0);
    for (let attempt = 0; attempt <= retries; attempt++) {
      let response: Response;
      try {
        response = await fetchWithTimeout(
          `${this.baseUrl}${path}`,
          {
            ...init,
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://github.com/kiarash707/KI00",
              "X-Title": "KI00",
              ...(init.headers ?? {}),
            },
          },
          options.timeoutMs ?? 30_000
        );
      } catch (error) {
        if (attempt < retries) {
          await sleep(500);
          continue;
        }
        throw new ProviderError("openrouter", 502, "OpenRouter is unreachable", {
          code: "OPENROUTER_UNREACHABLE",
          hint: error instanceof Error ? error.message : "Network error",
        });
      }

      const text = await response.text();
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (response.ok) return payload as T;

      const message =
        payload?.error?.message ?? payload?.message ?? `OpenRouter returned HTTP ${response.status}`;
      if ((response.status === 429 || response.status === 502 || response.status === 503) && attempt < retries) {
        const after = parseRetryAfter(response.headers.get("retry-after"));
        await sleep(Math.min(after ?? 700, 2500));
        continue;
      }
      const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
      throw new ProviderError("openrouter", response.status, message, {
        code: retryable
          ? "OPENROUTER_RETRYABLE"
          : response.status === 401
            ? "OPENROUTER_AUTH"
            : response.status === 402
              ? "OPENROUTER_CREDITS"
              : response.status === 404
                ? "OPENROUTER_MODEL_UNAVAILABLE"
                : "OPENROUTER_ERROR",
        hint:
          response.status === 401
            ? "The OPENROUTER_API_KEY is invalid. KI00 never falls back to a paid model."
            : response.status === 402
              ? "The OpenRouter account has insufficient credits. KI00 only uses free models."
              : response.status === 404
                ? "The selected free model is no longer available. Refresh the model catalog."
                : retryable
                  ? "Temporary provider error; KI00 may retry with another free model."
                  : undefined,
      });
    }
    throw new ProviderError("openrouter", 502, "OpenRouter request failed");
  }

  async fetchModels(): Promise<RawModel[]> {
    const payload = await this.request<RawCatalog>("/models", {}, { timeoutMs: 25_000 });
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  async keyInfo(): Promise<{ label: string | null; usage: number | null; limit: number | null; isFreeTier: boolean | null }> {
    const payload = await this.request<{ data?: { label?: string; usage?: number; limit?: number; is_free_tier?: boolean } }>(
      "/key",
      {},
      { retries: 0 }
    );
    return {
      label: payload?.data?.label ?? null,
      usage: typeof payload?.data?.usage === "number" ? payload.data.usage : null,
      limit: typeof payload?.data?.limit === "number" ? payload.data.limit : null,
      isFreeTier: typeof payload?.data?.is_free_tier === "boolean" ? payload.data.is_free_tier : null,
    };
  }

  async chat(input: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: input.model,
      messages: input.messages,
      max_tokens: Math.min(input.maxTokens ?? 4096, 8192),
      temperature: input.temperature ?? 0.2,
      usage: { include: true },
    };
    if (input.tools?.length) {
      body.tools = input.tools;
      body.tool_choice = "auto";
    }
    const payload = await this.request<any>("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const choice = payload?.choices?.[0];
    if (!choice) {
      throw new ProviderError("openrouter", 502, "OpenRouter returned no completion choices", {
        code: "OPENROUTER_EMPTY",
        hint: "Retry the run or select a different free model.",
      });
    }
    const message = choice.message ?? {};
    const rawToolCalls: unknown[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: ToolCall[] = rawToolCalls
      .map((call): ToolCall | null => {
        const item = call as { id?: string; type?: string; function?: { name?: string; arguments?: string } };
        if (!item?.function?.name) return null;
        return {
          id: item.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: {
            name: item.function.name,
            arguments: item.function.arguments ?? "{}",
          },
        };
      })
      .filter((call): call is ToolCall => Boolean(call));

    return {
      content: typeof message.content === "string" ? message.content : "",
      toolCalls,
      finishReason: choice.finish_reason ?? null,
      promptTokens: Number(payload?.usage?.prompt_tokens ?? 0),
      completionTokens: Number(payload?.usage?.completion_tokens ?? 0),
      model: String(payload?.model ?? input.model),
    };
  }
}

export interface SelectionResult {
  models: FreeModel[];
  selectedModel: string | null;
  selectedModelName: string | null;
  selectionReason: string | null;
  overrideApplied: boolean;
  overrideRejected: string | null;
}

const MIN_CONTEXT = 16_000;
const PREFERRED_CONTEXT = 64_000;
const CODING_KEYWORDS = [
  "coder",
  "code",
  "coding",
  "dev",
  "reason",
  "reasoning",
  "think",
  "instruct",
  "qwen",
  "deepseek",
  "coder",
  "sonnet",
  "hermes",
  "mistral",
  "llama",
];

/**
 * Builds a ranked free-model catalog strictly from OpenRouter metadata:
 * price, tool support, context size, and release recency. There is no invented
 * "intelligence score"; naming heuristics are exposed as reasons.
 */
export function rankFreeModels(raw: RawModel[], nowMs = Date.now()): FreeModel[] {
  const models: FreeModel[] = [];
  for (const model of raw) {
    if (!model.id) continue;
    const pricing = model.pricing ?? {};
    const prompt = parsePrice(pricing.prompt);
    const completion = parsePrice(pricing.completion);
    const request = parsePrice(pricing.request ?? "0");
    if (prompt === null || completion === null) continue;
    if (prompt > 0 || completion > 0 || (request ?? 0) > 0) continue;
    const outputs = model.architecture?.output_modalities ?? ["text"];
    if (!outputs.includes("text")) continue;
    const id = model.id.toLowerCase();
    if (id.includes("embed") || id.includes("rerank") || id.includes("moderation")) continue;
    const supported = model.supported_parameters ?? [];
    if (!supported.includes("tools")) continue;

    const contextLength = Number(model.context_length ?? 0);
    if (contextLength < MIN_CONTEXT) continue;

    const reasons = ["Zero input/output price", "Tool calling supported", `${contextLength.toLocaleString("en-US")} token context`];
    let score = 0;
    score += Math.min(30, Math.log2(contextLength) * 3);
    const ageDays = model.created ? Math.max(0, (nowMs / 1000 - model.created) / 86_400) : 365;
    score += Math.max(0, 14 - Math.min(14, ageDays / 30));
    const keywords = CODING_KEYWORDS.filter((keyword) => id.includes(keyword));
    if (keywords.length) {
      score += Math.min(12, keywords.length * 4);
      reasons.push(`Coding/reasoning oriented name (${keywords.slice(0, 3).join(", ")})`);
    }
    if (contextLength >= PREFERRED_CONTEXT) {
      score += 6;
      reasons.push("Large context window");
    }
    const isInstruct = supported.includes("tools") && !id.includes("base");
    if (!isInstruct) score -= 8;
    models.push({
      id: model.id,
      name: model.name ?? model.id,
      contextLength,
      maxCompletionTokens: model.top_provider?.max_completion_tokens ?? null,
      supportsTools: true,
      promptPrice: pricing.prompt ?? "0",
      completionPrice: pricing.completion ?? "0",
      created: Number(model.created ?? 0),
      score: Math.round(score * 100) / 100,
      reasons,
      modality: model.architecture?.modality ?? null,
    });
  }

  return models.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.contextLength !== a.contextLength) return b.contextLength - a.contextLength;
    return b.created - a.created;
  });
}

export function selectFreeModel(
  models: FreeModel[],
  overrideRaw?: string | null
): SelectionResult {
  if (models.length === 0) {
    return {
      models: [],
      selectedModel: null,
      selectedModelName: null,
      selectionReason: null,
      overrideApplied: false,
      overrideRejected: null,
    };
  }
  const override = overrideRaw?.trim();
  if (override) {
    const match = models.find((model) => model.id === override);
    if (match) {
      return {
        models,
        selectedModel: match.id,
        selectedModelName: match.name,
        selectionReason: `Manually selected with KI00_AGENT_MODEL. ${match.reasons.join(" · ")}`,
        overrideApplied: true,
        overrideRejected: null,
      };
    }
    return {
      models,
      selectedModel: models[0]!.id,
      selectedModelName: models[0]!.name,
      selectionReason: `Auto-selected. ${models[0]!.reasons.join(" · ")}`,
      overrideApplied: false,
      overrideRejected: `KI00_AGENT_MODEL="${override}" is not a free model with tool support, so it was ignored.`,
    };
  }
  const best = models[0]!;
  return {
    models,
    selectedModel: best.id,
    selectedModelName: best.name,
    selectionReason: `Auto-selected by price, tool support, context and recency. ${best.reasons.join(" · ")}`,
    overrideApplied: false,
    overrideRejected: null,
  };
}

export function fallbackModels(models: FreeModel[], current: string, attempted: string[]): FreeModel[] {
  return models
    .filter((model) => model.id !== current && !attempted.includes(model.id))
    .slice(0, 3);
}

function parsePrice(value: string | undefined): number | null {
  if (value === undefined) return 0;
  if (value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
