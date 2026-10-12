import { describe, expect, it, vi } from "vitest";
import type { AgentModels } from "@oxbit/sdk";
import { BUILTIN_MODELS, MODELS_DEV_URL, modelsDevIndex, trimModelsDev, type CatalogCache } from "./catalog.js";
import type { AuthStore } from "./http.js";
import { ANTHROPIC_VERSION, endpointUrl, httpModels } from "./models.js";
import { apiKeySlot, planModels, provider } from "./registry.js";
import { describePlanError } from "./siwc.js";

const memoryStore = (): AuthStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (key) => data.get(key), set: async (key, value) => void data.set(key, value), delete: async (key) => void data.delete(key) };
};
const memoryCache = (entry?: { text: string; savedAt: number }): CatalogCache & { saved: string[] } => {
  const saved: string[] = [];
  return { saved, get: async () => entry, set: async (_key, text) => void saved.push(text) };
};
const collect = async (items: AsyncIterable<string>) => {
  let text = "";
  for await (const item of items) text += item;
  return text;
};
const keys: AgentModels["keys"] = { has: async () => true, save: async () => {}, remove: async () => {} };
const modelsDev = { openrouter: { models: { "x/y": { limit: { context: 200000, output: 32000 } }, "x/none": { limit: {} } } },
  openai: { models: { "gpt-9": { limit: { context: 2000000, output: 100000 } } } } };

describe("httpModels", () => {
  it("sends x-api-key and anthropic-version to Anthropic and fails redirects", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const models = httpModels({ fetch, keys, credentials: { get: async () => "sk-ant-test" } });
    expect(await collect(models.stream({ api: "anthropic", method: "POST", path: "/v1/messages", body: { a: 1 } }))).toBe("ok");
    expect(fetch).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({ method: "POST", body: '{"a":1}', redirect: "error",
      headers: { "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION, "x-api-key": "sk-ant-test" } }));
  });

  it("refreshes once after a 401 and passes error bodies through describe", async () => {
    const statuses = [401, 200, 429];
    const fetch = vi.fn(async () => new Response(statuses.length === 1 ? '{"error":{"code":"limit"}}' : "chunk", { status: statuses.shift() }));
    const refresh = vi.fn(async () => "new-token");
    const models = httpModels({ fetch, keys, credentials: { get: async () => "old-token", refresh }, describe: (status, body) => `${status}:${body}` });
    expect(await collect(models.stream({ api: "openai", method: "GET", path: "/v1/models" }))).toBe("chunk");
    expect(fetch.mock.calls.map((call: any[]) => call[1].headers.authorization)).toEqual(["Bearer old-token", "Bearer new-token"]);
    await expect(collect(models.stream({ api: "openai", method: "GET", path: "/v1/models" }))).rejects.toMatchObject({ status: 429, body: '429:{"error":{"code":"limit"}}' });
  });

  it("keeps requests under the endpoint base", () => {
    expect(endpointUrl({ api: "openai-compatible", baseUrl: "https://openrouter.ai/api/" }, "/v1/models")).toBe("https://openrouter.ai/api/v1/models");
    expect(endpointUrl({ api: "openai-compatible", baseUrl: "http://localhost:11434" }, "/v1/chat/completions", true)).toBe("http://localhost:11434/v1/chat/completions");
    for (const path of ["/../v1", "//evil.example.com/v1", "/v1/%2e%2e/x", "/v1 x"])
      expect(() => endpointUrl({ api: "openai", baseUrl: undefined }, path)).toThrow("is not allowed");
    expect(() => endpointUrl({ api: "openai-compatible", baseUrl: "http://example.com" }, "/v1/models", true)).toThrow(/https:\/\//);
    expect(() => endpointUrl({ api: "openai-compatible", baseUrl: "https://user:pw@example.com" }, "/v1/models")).toThrow(/credentials/);
    expect(() => endpointUrl({ api: "openai-compatible", baseUrl: "http://localhost:11434" }, "/v1/models")).toThrow(/https:\/\//);
  });
});

describe("provider catalog", () => {
  const route = (handlers: Record<string, () => Response>) => vi.fn(async (url: string) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    return handler();
  });

  it("falls back to the built-in OpenAI table when the list fails", async () => {
    const fetch = route({ "https://api.openai.com/v1/models": () => new Response("down", { status: 503 }) });
    const runtime = provider({ provider: "openai", method: "api-key" }, { fetch, auth: memoryStore(), env: { OPENAI_API_KEY: "sk-env" } });
    expect(await runtime.catalog()).toEqual(BUILTIN_MODELS.openai);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as any[])[1].headers.authorization).toBe("Bearer sk-env");
  });

  it("fills Anthropic limits from the list, then the built-in table for dated snapshots", async () => {
    const fetch = route({ "https://api.anthropic.com/v1/models": () => Response.json({ data: [
      { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 900000, max_tokens: 64000 },
      { id: "claude-sonnet-5-5-20260901", display_name: "Claude Sonnet 5.5" },
    ] }) });
    const auth = memoryStore();
    auth.data.set("apikey:anthropic", "sk-ant");
    const runtime = provider({ provider: "anthropic" }, { fetch, auth });
    expect(await runtime.catalog()).toEqual([
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 900000, maxOutput: 64000 },
      { id: "claude-sonnet-5-5-20260901", name: "Claude Sonnet 5.5", contextWindow: 1000000, maxOutput: 128000 },
    ]);
  });

  it("uses models.dev for unknown models and caches the trimmed index", async () => {
    const fetch = route({
      "https://openrouter.ai/api/v1/models": () => Response.json({ data: [{ id: "x/y", name: "Y" }, { id: "x/z", name: "Z" }] }),
      [MODELS_DEV_URL]: () => Response.json(modelsDev),
    });
    const cache = memoryCache();
    const runtime = provider({ provider: "openrouter" }, { fetch, auth: memoryStore(), cache, now: () => 1000 });
    expect(await runtime.catalog()).toEqual([{ id: "x/y", name: "Y", contextWindow: 200000, maxOutput: 32000 }, { id: "x/z", name: "Z" }]);
    expect(JSON.parse(cache.saved[0])).toEqual({ openrouter: { "x/y": [200000, 32000] }, openai: { "gpt-9": [2000000, 100000] } });
    await runtime.catalog();
    expect(fetch.mock.calls.filter((call: any[]) => call[0] === MODELS_DEV_URL)).toHaveLength(1);
  });

  it("prefers a fresh cache, downloads when stale, and keeps the stale copy when the download fails", async () => {
    const index = JSON.stringify(trimModelsDev(modelsDev));
    const failing = vi.fn(async () => new Response("down", { status: 500 }));
    expect(await modelsDevIndex({ fetch: failing, cache: memoryCache({ text: index, savedAt: 0 }), now: () => 1000 })).toEqual(JSON.parse(index));
    expect(failing).not.toHaveBeenCalled();
    const stale = memoryCache({ text: index, savedAt: 0 });
    expect(await modelsDevIndex({ fetch: failing, cache: stale, now: () => 2 * 86400000 })).toEqual(JSON.parse(index));
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await modelsDevIndex({ fetch: failing })).toBeUndefined();
  });

  it("lists ChatGPT plan models and maps plan errors", async () => {
    expect(planModels({ models: [
      { slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list", supported_in_api: true, context_window: 1050000,
        supported_reasoning_levels: [{ effort: "max", description: "" }, { effort: "low", description: "" }, { effort: "ultra", description: "" }] },
      { slug: "gpt-old", visibility: "list" },
      { slug: "hidden", visibility: "hide" },
      { slug: "app-only", visibility: "list", supported_in_api: false },
    ] })).toEqual([{ id: "gpt-6-sol", name: "GPT-6 Sol", contextWindow: 1050000, efforts: ["low", "max"] }, { id: "gpt-old", name: "gpt-old" }]);
    expect(JSON.parse(describePlanError(429, JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded" } }))).error.message)
      .toBe("ChatGPT plan usage limit reached. Manage usage: https://chatgpt.com/settings/usage");
    expect(JSON.parse(describePlanError(400, JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "temperature" } }))).error.message)
      .toBe("ChatGPT plan usage does not support temperature.");
    expect(describePlanError(500, "plain")).toBe("plain");
  });

  it("stores keys per provider, per origin for openai-compatible, and sends none for Ollama", async () => {
    const auth = memoryStore();
    const compatible = provider({ provider: "openai-compatible", baseUrl: "https://llm.example.com/v1x" }, { fetch: vi.fn(), auth });
    await compatible.models().keys.save(compatible.endpoint(), "k1");
    expect(auth.data.get(apiKeySlot("openai-compatible", "https://llm.example.com/other"))).toBe("k1");
    expect(() => provider({ provider: "openai-compatible" }, { fetch: vi.fn(), auth })).toThrow("Set a base URL for OpenAI-compatible");
    const fetch = vi.fn(async () => Response.json({ data: [{ id: "llama3" }] }));
    const ollama = provider({ provider: "ollama" }, { fetch, auth });
    expect(await ollama.models().keys.has(ollama.endpoint())).toBe(true);
    expect(await ollama.catalog()).toEqual([{ id: "llama3", name: "llama3" }]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434/v1/models", expect.objectContaining({ headers: {} }));
  });
});
