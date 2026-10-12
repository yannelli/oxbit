import type { ModelInfo } from "../model.js";
import type { Fetch } from "./http.js";

/** Host cache for the models.dev index, for example a file under ~/.oxbit/agent/cache. */
export interface CatalogCache {
  get(key: string): Promise<{ text: string; savedAt: number } | undefined>;
  set(key: string, text: string): Promise<void>;
}

const OPENAI_WINDOW = { contextWindow: 1050000, maxOutput: 128000 };
const CLAUDE_WINDOW = { contextWindow: 1000000, maxOutput: 128000 };
/** From developers.openai.com/api/docs/models and platform.claude.com/docs/en/about-claude/models/overview, fetched 2026-10-11. */
export const BUILTIN_MODELS: Record<"openai" | "anthropic", ModelInfo[]> = {
  openai: [
    { id: "gpt-6-astra", name: "GPT-6 Astra", ...OPENAI_WINDOW },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", ...OPENAI_WINDOW },
    { id: "gpt-6-sol", name: "GPT-6 Sol", ...OPENAI_WINDOW },
    { id: "gpt-6-luna", name: "GPT-6 Luna", ...OPENAI_WINDOW },
    { id: "gpt-5.5", name: "GPT-5.5", ...OPENAI_WINDOW },
    { id: "gpt-5.4", name: "GPT-5.4", ...OPENAI_WINDOW },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 400000, maxOutput: 128000 },
  ],
  anthropic: [
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", ...CLAUDE_WINDOW },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", ...CLAUDE_WINDOW },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", ...CLAUDE_WINDOW },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", ...CLAUDE_WINDOW },
  ],
};

/** The built-in entry for `id`, also for dated snapshots such as `gpt-5.5-2026-04-23`. */
export function builtinModel(provider: string, id: string) {
  const list = BUILTIN_MODELS[provider as keyof typeof BUILTIN_MODELS] ?? [];
  const base = id.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, "");
  return list.find((model) => model.id === id) ?? list.find((model) => model.id === base);
}

export const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_KEY = "models.dev";
const DAY = 86400000;
/** provider ID -> model ID -> [context window, max output]. */
export type ModelsDevIndex = Record<string, Record<string, [number, number]>>;

const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 0;
/** Keeps only the limits from models.dev api.json, which is about 5 MB. */
export function trimModelsDev(body: unknown): ModelsDevIndex {
  const index: ModelsDevIndex = {};
  if (!body || typeof body !== "object") return index;
  for (const [provider, info] of Object.entries(body as Record<string, any>)) {
    const models = info?.models;
    if (!models || typeof models !== "object") continue;
    const limits: Record<string, [number, number]> = {};
    for (const [id, model] of Object.entries(models as Record<string, any>)) {
      const context = positive(model?.limit?.context);
      if (context) limits[id] = [context, positive(model?.limit?.output)];
    }
    index[provider] = limits;
  }
  return index;
}

export interface ModelsDevOptions {
  fetch: Fetch;
  cache?: CatalogCache;
  now?(): number;
  url?: string;
  maxAgeMs?: number;
}

/** The models.dev index: a fresh cache entry, else a download, else a stale cache entry, else undefined. */
export async function modelsDevIndex(options: ModelsDevOptions, signal?: AbortSignal): Promise<ModelsDevIndex | undefined> {
  const now = options.now?.() ?? Date.now();
  const parse = (text: string) => {
    try {
      return JSON.parse(text) as ModelsDevIndex;
    } catch {
      return undefined;
    }
  };
  const cached = await options.cache?.get(CACHE_KEY).catch(() => undefined);
  const stale = cached ? parse(cached.text) : undefined;
  if (stale && now - cached!.savedAt < (options.maxAgeMs ?? DAY)) return stale;
  try {
    const response = await options.fetch(options.url ?? MODELS_DEV_URL, { signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
    const index = trimModelsDev(await response.json());
    await options.cache?.set(CACHE_KEY, JSON.stringify(index)).catch(() => {});
    return index;
  } catch {
    return stale;
  }
}

export interface LimitSources {
  /** Built-in table to use: "openai" or "anthropic". */
  builtin?: string;
  /** models.dev provider ID, for example "openrouter". */
  modelsDev?: string;
  index?: (signal?: AbortSignal) => Promise<ModelsDevIndex | undefined>;
}

/** Fills missing context windows and output limits from the built-in table, then from models.dev. */
export async function fillLimits(models: ModelInfo[], sources: LimitSources, signal?: AbortSignal): Promise<ModelInfo[]> {
  let filled = models.map((model) => {
    const known = sources.builtin ? builtinModel(sources.builtin, model.id) : undefined;
    return known ? { ...model, contextWindow: model.contextWindow ?? known.contextWindow, maxOutput: model.maxOutput ?? known.maxOutput } : model;
  });
  if (!sources.modelsDev || !sources.index || filled.every((model) => model.contextWindow)) return filled;
  const limits = (await sources.index(signal))?.[sources.modelsDev];
  if (!limits) return filled;
  filled = filled.map((model) => {
    const [context, output] = limits[model.id] ?? [];
    return context ? { ...model, contextWindow: model.contextWindow ?? context, maxOutput: model.maxOutput ?? (output || undefined) } : model;
  });
  return filled;
}
