import { describe, expect, it, vi } from "vitest";
import { normalizeBase, nodeModels, requestUrl, selectProvider } from "./providers.js";

const select = (input: Partial<Parameters<typeof selectProvider>[0]> = {}) =>
  selectProvider({ settings: {}, env: {}, storedKey: () => undefined, ...input });

describe("selectProvider", () => {
  it("prefers the flag, then settings, then an environment key, then ollama", () => {
    expect(select().id).toBe("ollama");
    expect(select({ env: { ANTHROPIC_API_KEY: "a" } })).toEqual(expect.objectContaining({ id: "anthropic", key: "a", endpoint: { api: "anthropic" } }));
    expect(select({ env: { ANTHROPIC_API_KEY: "a" }, settings: { provider: "openai" }, storedKey: (id) => id === "openai" ? "stored" : undefined }))
      .toEqual(expect.objectContaining({ id: "openai", key: "stored" }));
    expect(select({ provider: "openrouter", env: { OPENROUTER_API_KEY: "o" } }))
      .toEqual(expect.objectContaining({ id: "openrouter", endpoint: { api: "openai-compatible", baseUrl: "https://openrouter.ai/api" } }));
    expect(() => select({ provider: "nope" })).toThrow("Unknown provider nope");
  });

  it("uses the Ollama base without /v1 and the model from settings for the same provider", () => {
    expect(select({ settings: { provider: "ollama", model: "qwen3:0.6b" } })).toEqual(expect.objectContaining({
      base: "http://127.0.0.1:11434", endpoint: { api: "openai-compatible", baseUrl: "http://127.0.0.1:11434" }, model: "qwen3:0.6b" }));
    expect(select({ env: { OLLAMA_HOST: "127.0.0.1:9999" } }).base).toBe("http://127.0.0.1:9999");
    expect(select({ provider: "ollama", settings: { provider: "openai", model: "gpt-5" } }).model).toBeUndefined();
    expect(select({ provider: "ollama", model: "llama3" }).model).toBe("llama3");
    expect(() => select({ provider: "openai-compatible" })).toThrow("baseUrl");
  });

  it("accepts https or loopback http base URLs only", () => {
    expect(normalizeBase("https://example.com/api/v1/")).toBe("https://example.com/api");
    expect(() => normalizeBase("http://example.com")).toThrow("https://");
    expect(() => normalizeBase("https://user:pw@example.com")).toThrow("credentials");
    expect(() => requestUrl("https://example.com/api", "/../x")).toThrow("not allowed");
    expect(requestUrl("https://example.com/api", "/v1/models").href).toBe("https://example.com/api/v1/models");
  });
});

describe("nodeModels", () => {
  const response = (body: string, status = 200) => new Response(body, { status });

  it("sends Anthropic headers and streams the body", async () => {
    const fetcher = vi.fn(async () => response("data: 1\n\ndata: 2\n\n"));
    const models = nodeModels(select({ provider: "anthropic", env: { ANTHROPIC_API_KEY: "sk-a" } }), undefined, fetcher as any);
    let text = "";
    for await (const chunk of models.stream({ api: "anthropic", method: "POST", path: "/v1/messages", body: { x: 1 } })) text += chunk;
    expect(text).toBe("data: 1\n\ndata: 2\n\n");
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://api.anthropic.com/v1/messages");
    expect(init).toEqual(expect.objectContaining({ method: "POST", redirect: "error", body: "{\"x\":1}",
      headers: expect.objectContaining({ "x-api-key": "sk-a", "anthropic-version": "2023-06-01" }) }));
  });

  it("uses a bearer key, reports HTTP errors with the body, and refuses other endpoints", async () => {
    const fetcher = vi.fn(async () => response("{\"error\":{\"message\":\"bad key\"}}", 401));
    const choice = select({ provider: "openrouter", env: { OPENROUTER_API_KEY: "sk-o" } });
    const models = nodeModels(choice, undefined, fetcher as any);
    const read = async (request: Parameters<typeof models.stream>[0]) => {
      for await (const _chunk of models.stream(request)) void _chunk;
    };
    await expect(read({ ...choice.endpoint, method: "GET", path: "/v1/models" })).rejects.toEqual(expect.objectContaining({ status: 401, body: "{\"error\":{\"message\":\"bad key\"}}" }));
    expect((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-o" }));
    await expect(read({ api: "openai", method: "GET", path: "/v1/models" })).rejects.toThrow("not the configured provider");
    expect(await models.keys.has(choice.endpoint)).toBe(true);
    expect(await nodeModels(select({ provider: "openai" })).keys.has({ api: "openai" })).toBe(false);
    expect(await nodeModels(select()).keys.has({ api: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" })).toBe(true);
  });
});
