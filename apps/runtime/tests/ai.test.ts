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

  it("rejects invalid parameters", async () => {
    const ai = new AiCompletions({ home: await agentHome({}, {}), env: {} });
    await expect(ai.complete({ system: "s" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(ai.complete({ system: "s", prompt: "p", maxTokens: 0 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});
