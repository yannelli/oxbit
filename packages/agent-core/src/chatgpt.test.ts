import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { CHATGPT_MODELS, chatgptResponses } from "./chatgpt.js";
import { listModels, type Turn } from "./model.js";
import { openaiResponses } from "./openai-responses.js";
import { ADAPTERS } from "./turn.js";
import { chunks, endpointOf, fakeModels, settings } from "./test-models.js";
import type { AgentHost } from "./host.js";

const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "enc" };
const call = { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}", status: "completed" };
const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Earlier", annotations: [] }] };
const listed = (slug: string, priority: number, visibility = "list") =>
  ({ slug, display_name: slug.toUpperCase(), visibility, priority, supported_in_api: true, context_window: 272000, supported_reasoning_levels: [] });
const named = (...events: Record<string, unknown>[]) => [events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")];

describe("ChatGPT adapter", () => {
  it("posts to /codex/responses with include, tool_choice and store: false, and without max_output_tokens", () => {
    const { method, path, body } = chatgptResponses.request({ model: "gpt-6-sol", system: "S", turns: [{ role: "user", text: "Hi" }],
      tools: [{ name: "t", description: "d", parameters: {} }], effort: "high", maxTokens: 30 }) as any;
    expect([method, path]).toEqual(["POST", "/codex/responses"]);
    expect(body).toEqual({
      model: "gpt-6-sol", instructions: "S", stream: true, store: false, include: ["reasoning.encrypted_content"], tool_choice: "auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
      tools: [{ type: "function", name: "t", description: "d", parameters: {}, strict: false }],
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(body).not.toHaveProperty("max_output_tokens");
    const plain = chatgptResponses.request({ model: "m", system: "", turns: [], tools: [] }) as any;
    expect(plain.body.instructions).toBe("You are a helpful assistant.");
    expect(plain.body).not.toHaveProperty("reasoning");
    expect(plain.body).not.toHaveProperty("tools");
  });
  it("replays output items saved by the openai and chatgpt adapters and reads Responses events", async () => {
    const turns: Turn[] = [
      { role: "user", text: "Read a.ts" },
      { role: "assistant", text: "Earlier", calls: [], native: { api: "openai", items: [message] } },
      { role: "assistant", text: "", calls: [{ id: "call_1", name: "read_file", arguments: call.arguments }], native: { api: "chatgpt", items: [reasoning, call] } },
      { role: "tool", results: [{ id: "call_1", name: "read_file", output: "text" }] },
    ];
    const { body } = chatgptResponses.request({ model: "m", system: "S", turns, tools: [] }) as any;
    expect(body.input.slice(1)).toEqual([message, reasoning, call, { type: "function_call_output", call_id: "call_1", output: "text" }]);
    const openai = (openaiResponses.request({ model: "m", system: "S", turns, tools: [] }) as any).body.input;
    expect(openai[2]).toEqual({ type: "function_call", call_id: "call_1", name: "read_file", arguments: call.arguments });
    expect(chatgptResponses.events).toBe(openaiResponses.events);
    expect(ADAPTERS.chatgpt).toBe(chatgptResponses);
  });
});

describe("ChatGPT model list", () => {
  it("lists visible models from /codex/models by priority", async () => {
    const { models, requests } = fakeModels([], { list: { models: [listed("gpt-b", 2), listed("hidden", 0, "hide"), listed("gpt-a", 1), { slug: "" }] } });
    expect(await listModels(models, { api: "chatgpt" })).toEqual([
      { id: "gpt-a", name: "GPT-A", contextWindow: 272000, efforts: [] },
      { id: "gpt-b", name: "GPT-B", contextWindow: 272000, efforts: [] },
    ]);
    expect(requests).toEqual([{ api: "chatgpt", method: "GET", path: "/codex/models?client_version=0.162.1" }]);
  });
  it("returns the bundled list when the request fails, the body has no models, or none is visible", async () => {
    const failing = { ...fakeModels([]).models, stream: () => { throw Object.assign(new Error("Unauthorized"), { status: 401, body: "" }); } };
    expect(await listModels(failing, { api: "chatgpt" })).toEqual(CHATGPT_MODELS);
    for (const list of [{ data: [{ id: "x" }] }, { models: [listed("hidden", 0, "hide")] }])
      expect((await listModels(fakeModels([], { list }).models, { api: "chatgpt" })).map((model) => model.id)).toEqual(CHATGPT_MODELS.map((model) => model.id));
    expect(CHATGPT_MODELS[0].id).toBe("gpt-6.1-sol");
    const aborted = AbortSignal.abort();
    await expect(listModels({ ...failing, stream: () => chunks(["{"]) }, { api: "chatgpt" }, aborted)).rejects.toThrow();
  });
  it("runs a session on the chatgpt endpoint with the listed model", async () => {
    const reply = named(
      { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
      { type: "response.output_item.done", output_index: 0, item: { ...message, content: [{ type: "output_text", text: "Hello", annotations: [] }] } },
      { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 1 } } },
    );
    const fake = fakeModels([reply], { list: { models: [listed("gpt-6-sol", 3)] } });
    const config = settings({ "agentACP.oxbit.api": "chatgpt", "agentACP.oxbit.model": "" });
    const host: AgentHost = {
      models: () => fake.models, endpoint: () => endpointOf(config), generateTitles: false, capabilities: { fs: true, terminal: false },
      model: () => config.get("agentACP.oxbit.model") as string | undefined, saveModel: () => {},
      filesystem: { list: async () => [] } as any, root: "/root", update: () => {}, request: async () => null,
    };
    const agent = new Agent(host);
    const session = await agent.newSession();
    expect(session.models?.currentModelId).toBe("gpt-6-sol");
    expect(await agent.prompt(session.sessionId, [{ type: "text", text: "Hi" }])).toEqual({ stopReason: "end_turn" });
    const post = fake.requests[1] as any;
    expect([post.api, post.method, post.path, post.body.model, post.body.store]).toEqual(["chatgpt", "POST", "/codex/responses", "gpt-6-sol", false]);
    expect(post.body.instructions).toContain("Oxbit Agent");
  });
});
