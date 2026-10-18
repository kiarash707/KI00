import type { ModelCatalog } from "../../shared/types";
import type { Env } from "../env";
import { dbFirst, dbRun } from "./db";
import { OpenRouterClient, rankFreeModels, selectFreeModel } from "./openrouter";
import { now } from "./utils";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = "openrouter:free-models";

interface CachePayload {
  raw: unknown[];
  fetchedAt: number;
}

export async function getModelCatalog(
  env: Env,
  options: { refresh?: boolean } = {}
): Promise<ModelCatalog> {
  const override = env.KI00_AGENT_MODEL ?? null;
  let cache = await readCache(env.DB);
  const stale = !cache || now() - cache.fetchedAt > CACHE_TTL_MS;
  let error: string | null = null;

  if ((stale || options.refresh) && env.OPENROUTER_API_KEY) {
    try {
      const client = OpenRouterClient.fromEnv(env);
      const raw = await client.fetchModels();
      const sanitized = raw.map((model) => ({
        id: model.id,
        name: model.name,
        created: model.created,
        context_length: model.context_length,
        architecture: model.architecture,
        pricing: model.pricing,
        supported_parameters: model.supported_parameters,
        top_provider: model.top_provider,
      }));
      cache = { raw: sanitized, fetchedAt: now() };
      await writeCache(env.DB, cache);
    } catch (err) {
      error = err instanceof Error ? err.message : "Could not refresh the OpenRouter model catalog";
    }
  }

  if (!env.OPENROUTER_API_KEY) {
    error = "OPENROUTER_API_KEY is not configured; the AI agent is disabled.";
  }

  const models = cache ? rankFreeModels(cache.raw as Parameters<typeof rankFreeModels>[0]) : [];
  const selection = selectFreeModel(models, override);
  return {
    models: models.slice(0, 80),
    selectedModel: selection.selectedModel,
    selectedModelName: selection.selectedModelName,
    selectionReason: selection.selectionReason ?? selection.overrideRejected,
    fetchedAt: cache?.fetchedAt ?? null,
    stale: cache ? now() - cache.fetchedAt > CACHE_TTL_MS : true,
    error,
    overridden: selection.overrideApplied,
  };
}

async function readCache(db: D1Database): Promise<CachePayload | null> {
  const row = await dbFirst<{ payload: string; fetched_at: number }>(
    db,
    "SELECT payload, fetched_at FROM model_cache WHERE id = ?",
    CACHE_KEY
  );
  if (!row) return null;
  try {
    return { raw: JSON.parse(row.payload) as unknown[], fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

async function writeCache(db: D1Database, cache: CachePayload): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO model_cache (id, payload, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
    CACHE_KEY,
    JSON.stringify(cache.raw),
    cache.fetchedAt
  );
}
