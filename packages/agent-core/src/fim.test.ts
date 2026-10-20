import { describe, expect, it } from "vitest";
import type { AgentModelRequest, AgentModels } from "@oxbit/sdk";
import { fimAvailable, fimComplete } from "./fim.js";

function models(respond: (request: AgentModelRequest) => string | Error) {
  const requests: AgentModelRequest[] = [];
  const service: AgentModels = {
    async *stream(request) {
      requests.push(request);
      const result = respond(request);
      if (result instanceof Error) throw result;
      yield result;
    },
    keys: { has: async () => true, save: async () => {}, remove: async () => {} },
  };
  return { service, requests };
}

describe("fimComplete", () => {
  const endpoint = { api: "openai-compatible" as const, baseUrl: "http://localhost:11434" };

  it("sends the prefix and suffix to /v1/completions and returns the choice text", async () => {
    const { service, requests } = models(() => JSON.stringify({ choices: [{ text: "a + b" }] }));
    expect(await fimComplete(service, endpoint, { model: "coder-base", prefix: "return ", suffix: ";\n", maxTokens: 64 })).toBe("a + b");
    expect(requests).toEqual([{ ...endpoint, method: "POST", path: "/v1/completions",
      body: { model: "coder-base", prompt: "return ", suffix: ";\n", temperature: 0.2, stream: false, max_tokens: 64 } }]);
  });

  it("returns undefined and stops offering FIM for a model the server rejects", async () => {
    const error = Object.assign(new Error("400"), { status: 400, body: '{"error":{"message":"qwen3 does not support insert"}}' });
    const { service } = models(() => error);
    expect(fimAvailable(endpoint, "chat-model")).toBe(true);
    expect(await fimComplete(service, endpoint, { model: "chat-model", prefix: "a", suffix: "b" })).toBeUndefined();
    expect(fimAvailable(endpoint, "chat-model")).toBe(false);
    expect(fimAvailable({ api: "openai" }, "gpt")).toBe(false);
  });

  it("throws other errors", async () => {
    const { service } = models(() => Object.assign(new Error("500"), { status: 500, body: "boom" }));
    await expect(fimComplete(service, endpoint, { model: "m", prefix: "a", suffix: "b" })).rejects.toThrow("500");
  });
});
