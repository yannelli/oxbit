import { describe, expect, it, vi } from "vitest";
import type { AgentModelRequest, AgentModels } from "@oxbit/sdk";

vi.mock("@oxbit/host-ios", () => ({ PROFILE_SCOPE: "profile", native: {} }));
const { AI_CONSENT_KEY, consentKey, withAiConsent } = await import("./ai-consent.js");

const router: AgentModelRequest = { api: "openai-compatible", baseUrl: "https://openrouter.ai/api", method: "POST", path: "/v1/chat/completions" };

function setup(answer: string | undefined, saved: string[] | null = null) {
  const store = new Map<string, unknown>(saved ? [[`profile:${AI_CONSENT_KEY}`, saved]] : []);
  const storage = {
    storageGet: vi.fn(async (scope: string, key: string) => store.get(`${scope}:${key}`) ?? null),
    storageSet: vi.fn(async (scope: string, key: string, value: unknown) => void store.set(`${scope}:${key}`, value)),
  };
  const sent: AgentModelRequest[] = [];
  const models: AgentModels = {
    keys: { has: vi.fn(), save: vi.fn(), remove: vi.fn() },
    async *stream(request) {
      sent.push(request);
      yield "ok";
    },
  };
  const ask = vi.fn(async () => answer);
  return { gated: withAiConsent(models, ask, storage as never), ask, sent, store };
}

async function read(models: AgentModels, request: AgentModelRequest) {
  let text = "";
  for await (const chunk of models.stream(request)) text += chunk;
  return text;
}

describe("withAiConsent", () => {
  it("keys endpoints by api and origin, matching the Keychain account", () => {
    expect(consentKey(router)).toBe("openai-compatible https://openrouter.ai");
    expect(consentKey({ api: "anthropic" })).toBe("anthropic https://api.anthropic.com");
  });

  it("asks once, sends after Allow, and saves the choice", async () => {
    const { gated, ask, sent, store } = setup("Allow");
    expect(await Promise.all([read(gated, router), read(gated, router)])).toEqual(["ok", "ok"]);
    expect(await read(gated, router)).toBe("ok");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).toBe("Share data with openrouter.ai?");
    expect(sent).toHaveLength(3);
    expect(store.get(`profile:${AI_CONSENT_KEY}`)).toEqual(["openai-compatible https://openrouter.ai"]);
  });

  it("sends nothing after Don't Allow and does not ask again", async () => {
    const { gated, ask, sent } = setup("Don't Allow");
    await expect(read(gated, router)).rejects.toThrow("sharing data with openrouter.ai is not allowed");
    await expect(read(gated, { ...router, api: "openai-compatible" })).rejects.toThrow();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it("skips the question for a saved endpoint and asks for a new one", async () => {
    const { gated, ask } = setup("Allow", ["openai-compatible https://openrouter.ai"]);
    await read(gated, router);
    expect(ask).not.toHaveBeenCalled();
    await read(gated, { api: "openai", method: "POST", path: "/v1/responses" });
    expect(ask).toHaveBeenCalledWith("Share data with OpenAI?", expect.stringContaining("OpenAI handles this data"), ["Allow", "Don't Allow"]);
  });
});
