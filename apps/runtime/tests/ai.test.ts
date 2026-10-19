import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chatText } from "@oxbit/agent-core/test-models";
import { AiCompletions } from "../src/ai.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });

async function agentHome(settings: unknown, auth: Record<string, string>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-ai-"));
  homes.push(home);
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify(settings));
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(auth));
  return home;
}

function recordingFetch(body: string[]) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(body.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { calls, fetch };
}

describe("AiCompletions", () => {
  it("sends one request with the agent's provider, saved key and requested model", async () => {
    const home = await agentHome({ provider: "openrouter", model: "agent-model" }, { "apikey:openrouter": "sk-test" });
    const { calls, fetch } = recordingFetch(chatText("return a + b;"));
    const ai = new AiCompletions({ home, env: {}, fetch });
    const result = await ai.complete({ system: "Complete code.", prompt: "function add(a, b) {", model: "fast-model", maxTokens: 64 });
    expect(result).toEqual({ text: "return a + b;", model: "fast-model" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-test");
    expect(calls[0].body.model).toBe("fast-model");
    expect(JSON.stringify(calls[0].body.messages)).toContain("function add(a, b) {");
  });

  it("falls back to the agent's model", async () => {
    const home = await agentHome({ provider: "openrouter", model: "agent-model" }, { "apikey:openrouter": "sk-test" });
    const { calls, fetch } = recordingFetch(chatText("x"));
    await new AiCompletions({ home, env: {}, fetch }).complete({ system: "s", prompt: "p" });
    expect(calls[0].body.model).toBe("agent-model");
  });

  it("reports a missing key without calling the provider", async () => {
    const home = await agentHome({ provider: "openrouter", model: "m" }, {});
    const { calls, fetch } = recordingFetch(chatText("x"));
    await expect(new AiCompletions({ home, env: {}, fetch }).complete({ system: "s", prompt: "p" }))
      .rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("No API key for openrouter") });
    expect(calls).toHaveLength(0);
  });

  it("sends to the provider the request names with that provider's saved key", async () => {
    const home = await agentHome({ provider: "anthropic", model: "agent-model" }, { "apikey:openrouter": "sk-router" });
    const { calls, fetch } = recordingFetch(chatText("x"));
    await new AiCompletions({ home, env: {}, fetch }).complete({ system: "s", prompt: "p", provider: "openrouter", model: "vendor/fast" });
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-router");
    expect(calls[0].body.model).toBe("vendor/fast");
  });

  it("sends to a local server at the request's base URL without a key", async () => {
    const home = await agentHome({ provider: "anthropic" }, {});
    const { calls, fetch } = recordingFetch(chatText("x"));
    await new AiCompletions({ home, env: {}, fetch }).complete({ system: "s", prompt: "p", provider: "ollama", baseUrl: "http://127.0.0.1:8080", model: "qwen3.5:9b" });
    expect(calls[0].url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(calls[0].headers.get("authorization")).toBeNull();
  });

  it("saves the key a custom OpenAI API request uses and lists that server's models", async () => {
    const home = await agentHome({}, {});
    const ai = new AiCompletions({ home, env: {}, fetch: async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-custom");
      return new Response(JSON.stringify({ data: [{ id: "served-a" }] }), { status: 200 });
    } });
    const custom = { provider: "openai-compatible", baseUrl: "https://api.example.com/" };
    expect(await ai.key({ operation: "has", ...custom })).toEqual({ saved: false });
    await ai.key({ operation: "save", ...custom, key: " sk-custom " });
    expect(await ai.key({ operation: "has", ...custom })).toEqual({ saved: true });
    expect(JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"))).toMatchObject({ "apikey:openai-compatible https://api.example.com": "sk-custom" });
    expect(await ai.models(custom)).toEqual({ models: ["served-a"] });
    await ai.key({ operation: "remove", ...custom });
    expect(await ai.key({ operation: "has", ...custom })).toEqual({ saved: false });
  });

  it("rejects providers outside the editor list and keys with spaces", async () => {
    const ai = new AiCompletions({ home: await agentHome({}, {}), env: {} });
    await expect(ai.complete({ system: "s", prompt: "p", provider: "anthropic", model: "m" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(ai.complete({ system: "s", prompt: "p", provider: "openrouter" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(ai.key({ operation: "save", provider: "ollama", key: "k" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(ai.key({ operation: "save", provider: "openrouter", key: "sk two" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("rejects invalid parameters", async () => {
    const ai = new AiCompletions({ home: await agentHome({}, {}), env: {} });
    await expect(ai.complete({ system: "s" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(ai.complete({ system: "s", prompt: "p", maxTokens: 0 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});
