import { describe, expect, it } from "vitest";
import { LocalAgent, type AgentHost } from "./agent.js";
import { chatText, chatTool, endpointOf, fakeModels, settings, type Reply } from "./test-models.js";

function setup(replies: Reply[], values?: Record<string, unknown>, list?: unknown) {
  const fake = fakeModels(replies, { list });
  const config = settings(values);
  const updates: Record<string, any>[] = [];
  const host: AgentHost = {
    models: () => fake.models, endpoint: () => endpointOf(config), configuration: config as any, filesystem: { list: async () => [] } as any, root: "/root",
    update: (_sessionId, update) => updates.push(update),
    request: async (method, params) => method === "fs/read_text_file" ? { content: `text of ${params.path}` } : null,
  };
  return { agent: new LocalAgent(host), updates, config, ...fake };
}
const kinds = (updates: Record<string, any>[]) => updates.map((update) => update.sessionUpdate + (update.status ? `:${update.status}` : ""));

describe("LocalAgent", () => {
  it("lists models for a new session with model and reasoning config options", async () => {
    const { agent, requests } = setup([]);
    const session = await agent.newSession();
    expect(requests[0]).toEqual({ api: "openai-compatible", baseUrl: "https://models.test/api", method: "GET", path: "/v1/models" });
    expect(session.models).toEqual({ currentModelId: "model-a", availableModels: [{ modelId: "model-a", name: "model-a" }, { modelId: "model-b", name: "model-b" }] });
    expect(session.configOptions.map((option) => [option.id, option.category, option.currentValue])).toEqual([["model", "model", "model-a"], ["reasoning", "thought_level", "default"]]);
  });
  it("falls back to the saved model when the list fails and persists a chosen model", async () => {
    const { agent, config } = setup([], { "agentACP.oxbit.model": "typed-id" }, { error: "no list" });
    const session = await agent.newSession();
    expect(session.models?.availableModels).toEqual([{ modelId: "typed-id", name: "typed-id" }]);
    expect(() => agent.setModel(session.sessionId, "other")).toThrow("not in the model list");
    agent.setModel(session.sessionId, "typed-id");
    expect(config.store["agentACP.oxbit.model"]).toBe("typed-id");
  });
  it("runs text, tool call, tool result and the next model turn in order", async () => {
    const { agent, updates, requests } = setup([chatTool("call_1", "read_file", { path: "a.ts" }), chatText("Done")]);
    const { sessionId } = await agent.newSession();
    expect(await agent.prompt(sessionId, [{ type: "text", text: "Read a.ts" }, { type: "resource", resource: { text: "Editor snapshot: b.ts\nB" } }]))
      .toEqual({ stopReason: "end_turn" });
    expect(kinds(updates)).toEqual(["tool_call:in_progress", "tool_call_update:completed", "agent_message_chunk", "usage_update"]);
    expect(updates.at(-1)).toEqual({ sessionUpdate: "usage_update", used: 12, size: 1000 });
    const [first, second] = requests.slice(1).map((request) => (request.body as any).messages);
    expect(first[1]).toEqual({ role: "user", content: "Read a.ts\n\nEditor snapshot: b.ts\nB" });
    expect(second.slice(2)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "text of /root/a.ts" },
    ]);
  });
  it("ends a cancelled turn when the host stream ignores the signal and drops calls from the unfinished response", async () => {
    const event = (value: Record<string, unknown>) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
    const call = { id: "fc_1", type: "function_call", call_id: "call_1", name: "list_files", arguments: "{}" };
    const ignoresSignal = async function* () {
      yield event({ type: "response.output_text.delta", output_index: 0, delta: "Partial" });
      yield event({ type: "response.output_item.done", output_index: 1, item: call });
      await new Promise(() => {});
    };
    const next = [event({ type: "response.output_text.delta", delta: "Next" }), event({ type: "response.completed", response: {} })];
    const { agent, updates, requests } = setup([ignoresSignal, next], { "agentACP.oxbit.api": "openai" });
    const { sessionId } = await agent.newSession();
    const turn = agent.prompt(sessionId, [{ type: "text", text: "Go" }]);
    await expect.poll(() => updates.length).toBe(1);
    agent.cancel(sessionId);
    expect(await turn).toEqual({ stopReason: "cancelled" });
    expect(await agent.prompt(sessionId, [{ type: "text", text: "Again" }])).toEqual({ stopReason: "end_turn" });
    expect(kinds(updates)).toEqual(["agent_message_chunk", "agent_message_chunk"]);
    expect((requests.at(-1)!.body as any).input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Go" }] },
      { type: "message", role: "assistant", content: "Partial" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Again" }] },
    ]);
  });
  it("reports API errors and drops the failed user turn", async () => {
    const failing = () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(Object.assign(new Error("HTTP"), { status: 401, body: "{\"error\":{\"message\":\"bad key\"}}" })) }) });
    const { agent, requests } = setup([failing, chatText("Ok")]);
    const { sessionId } = await agent.newSession();
    await expect(agent.prompt(sessionId, [{ type: "text", text: "First" }])).rejects.toThrow("Model API error 401: bad key");
    await agent.prompt(sessionId, [{ type: "text", text: "Second" }]);
    expect((requests.at(-1)!.body as any).messages.slice(1)).toEqual([{ role: "user", content: "Second" }]);
  });
});
