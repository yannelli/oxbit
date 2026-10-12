import { describe, expect, it, vi } from "vitest";
import type { AuthStore } from "@oxbit/agent-core";
import { missingKey, normalizeBase, selectProvider, type ProviderInput } from "./providers.js";

const memoryAuth = (entries: Record<string, string> = {}): AuthStore => {
  const data = new Map(Object.entries(entries));
  return { get: async (key) => data.get(key), set: async (key, value) => void data.set(key, value), delete: async (key) => void data.delete(key) };
};
const signedIn = JSON.stringify({ ext_agent_host_id: "urn:uuid:1", active: "oaiapp_1",
  accounts: [{ client_id: "oaiapp_1", issuer: "https://auth.openai.com", subject: "s", refresh_token: "r", scopes: ["chatgpt.tokens.use.direct"], saved_at: "" }] });
const select = (input: Partial<ProviderInput> = {}) => selectProvider({ settings: {}, env: {}, auth: memoryAuth(), fetch: vi.fn(), ...input });
const summary = async (input: Partial<ProviderInput> = {}) => {
  const choice = await select(input);
  return { id: choice.id, method: choice.runtime.method, endpoint: choice.runtime.endpoint(), model: choice.model, ready: choice.ready, label: choice.runtime.label };
};

describe("selectProvider", () => {
  it("prefers the flag, then settings, then a saved or environment key, then Ollama", async () => {
    expect(await summary()).toEqual({ id: "ollama", method: "none", endpoint: { api: "openai-compatible", baseUrl: "http://127.0.0.1:11434" },
      model: undefined, ready: true, label: "Ollama" });
    expect(await summary({ env: { ANTHROPIC_API_KEY: "a" } })).toMatchObject({ id: "anthropic", method: "api-key", endpoint: { api: "anthropic" }, ready: true });
    expect(await summary({ auth: memoryAuth({ "apikey:openrouter": "o" }) }))
      .toMatchObject({ id: "openrouter", endpoint: { api: "openai-compatible", baseUrl: "https://openrouter.ai/api" }, ready: true });
    expect(await summary({ env: { ANTHROPIC_API_KEY: "a" }, settings: { provider: "openai" } })).toMatchObject({ id: "openai", method: "api-key", ready: false });
    expect(await summary({ provider: "ollama", env: { ANTHROPIC_API_KEY: "a" }, settings: { provider: "openai" } })).toMatchObject({ id: "ollama" });
    await expect(select({ provider: "nope" })).rejects.toThrow("Unknown provider nope");
  });

  it("uses a ChatGPT sign-in for OpenAI unless settings choose the API key", async () => {
    const auth = memoryAuth({ chatgpt: signedIn });
    expect(await summary({ auth })).toMatchObject({ id: "openai", method: "chatgpt", ready: true, label: "Using ChatGPT plan" });
    expect(await summary({ auth, env: { OPENAI_API_KEY: "k" }, settings: { providers: { openai: { method: "api-key" } } } }))
      .toMatchObject({ method: "api-key", ready: true, label: "OpenAI" });
    expect(await summary({ provider: "openai", env: { OPENAI_API_KEY: "k" } })).toMatchObject({ method: "api-key", ready: true });
    expect(await summary({ provider: "openai", settings: { providers: { openai: { method: "chatgpt" } } } })).toMatchObject({ method: "chatgpt", ready: false });
    await expect(select({ provider: "anthropic", settings: { providers: { anthropic: { method: "chatgpt" } } } })).rejects.toThrow("does not support the chatgpt method");
  });

  it("reads base URLs and models from settings and the environment", async () => {
    expect(await summary({ settings: { provider: "ollama", model: "qwen3:0.6b" } })).toMatchObject({ model: "qwen3:0.6b" });
    expect((await summary({ env: { OLLAMA_HOST: "127.0.0.1:9999" } })).endpoint).toEqual({ api: "openai-compatible", baseUrl: "http://127.0.0.1:9999" });
    expect((await summary({ provider: "ollama", settings: { provider: "openai", model: "gpt-5" } })).model).toBeUndefined();
    expect((await summary({ provider: "ollama", model: "llama3", settings: { providers: { ollama: { model: "other" } } } })).model).toBe("llama3");
    expect(await summary({ provider: "openai-compatible", env: { OXBIT_AGENT_BASE_URL: "https://llm.example.com/v1/" } }))
      .toMatchObject({ method: "none", endpoint: { api: "openai-compatible", baseUrl: "https://llm.example.com" }, ready: true });
    const keyed = memoryAuth({ "apikey:openai-compatible https://llm.example.com": "k" });
    expect(await summary({ provider: "openai-compatible", auth: keyed, settings: { providers: { "openai-compatible": { baseUrl: "https://llm.example.com" } } } }))
      .toMatchObject({ method: "api-key", ready: true });
    await expect(select({ provider: "openai-compatible" })).rejects.toThrow("baseUrl");
  });

  it("accepts https or loopback http base URLs only", async () => {
    expect(normalizeBase("https://example.com/api/v1/")).toBe("https://example.com/api");
    expect(() => normalizeBase("http://example.com")).toThrow("https://");
    expect(() => normalizeBase("https://user:pw@example.com")).toThrow("credentials");
    await expect(select({ provider: "ollama", env: { OLLAMA_HOST: "http://10.0.0.2:11434" } })).rejects.toThrow("https://");
  });

  it("reads the key from auth.json before the environment and explains a missing one", async () => {
    const fetch = vi.fn(async () => new Response("data: 1\n\n"));
    const choice = await select({ provider: "anthropic", auth: memoryAuth({ "apikey:anthropic": "sk-saved" }), env: { ANTHROPIC_API_KEY: "sk-env" }, fetch });
    for await (const chunk of choice.runtime.models().stream({ api: "anthropic", method: "POST", path: "/v1/messages", body: {} })) void chunk;
    expect(fetch).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "sk-saved" }) }));
    expect(missingKey(await select({ provider: "openai" })).message)
      .toBe("No API key for openai. Set OPENAI_API_KEY or run `oxbit-agent login --provider openai`, or use your ChatGPT plan: oxbit-agent login chatgpt");
    expect(missingKey(await select({ provider: "openai", settings: { providers: { openai: { method: "chatgpt" } } } })).message)
      .toBe("Sign in with ChatGPT first: oxbit-agent login chatgpt");
  });
});
