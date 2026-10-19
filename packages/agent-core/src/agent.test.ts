import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { basePrompt } from "./turn.js";
import type { AgentHost } from "./host.js";
import { chatText, chatTool, endpointOf, fakeModels, settings, type Reply } from "./test-models.js";

function setup(replies: Reply[], values?: Record<string, unknown>, list?: unknown) {
  const fake = fakeModels(replies, { list });
  const config = settings(values);
  const updates: Record<string, any>[] = [];
  const host: AgentHost = {
    models: () => fake.models, endpoint: () => endpointOf(config), generateTitles: false, capabilities: { fs: true, terminal: false },
    model: () => config.get("agentACP.oxbit.model") as string | undefined, saveModel: (model) => config.set("agentACP.oxbit.model", model),
    filesystem: { list: async () => [] } as any, root: "/root",
    update: (_sessionId, update) => updates.push(update),
    request: async (method, params) => method === "fs/read_text_file" ? { content: `text of ${params.path}` } : null,
  };
  return { agent: new Agent(host), updates, config, ...fake };
}
const kinds = (updates: Record<string, any>[]) => updates.map((update) => update.sessionUpdate + (update.status ? `:${update.status}` : ""));

describe("Agent", () => {
  it("lists models for a new session with model and reasoning config options", async () => {
    const { agent, requests } = setup([]);
    const session = await agent.newSession();
    expect(requests[0]).toEqual({ api: "openai-compatible", baseUrl: "https://models.test/api", method: "GET", path: "/v1/models" });
    expect(session.models).toEqual({ currentModelId: "model-a", availableModels: [{ modelId: "model-a", name: "model-a" }, { modelId: "model-b", name: "model-b" }] });
    expect(session.configOptions.map((option) => [option.id, option.category, option.currentValue])).toEqual([["model", "model", "model-a"], ["reasoning", "thought_level", "default"], ["mode", "mode", "ask"]]);
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
    const shown = () => updates.filter((update) => update.sessionUpdate !== "available_commands_update");
    await expect.poll(() => shown().length).toBe(1);
    agent.cancel(sessionId);
    expect(await turn).toEqual({ stopReason: "cancelled" });
    expect(await agent.prompt(sessionId, [{ type: "text", text: "Again" }])).toEqual({ stopReason: "end_turn" });
    expect(kinds(shown())).toEqual(["agent_message_chunk", "agent_message_chunk"]);
    expect((requests.at(-1)!.body as any).input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Go" }] },
      { type: "message", role: "assistant", content: "Partial" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Again" }] },
    ]);
  });
  it("lists the selected model's reasoning levels, recomputes them on a model change, and falls back to the model default", async () => {
    const list = { data: [
      { id: "model-a", reasoning: { supported_efforts: ["xhigh", "high", "medium", "low"] } },
      { id: "model-b", reasoning: { supported_efforts: ["high", "medium", "low", "minimal"] } },
      { id: "model-c", supported_parameters: ["tools"] },
    ] };
    const { agent, requests } = setup([chatText("A"), chatText("C")], {}, list);
    const reasoning = (result: { configOptions: { id: string; currentValue: string; options: unknown[] }[] }) => {
      const option = result.configOptions.find((item) => item.id === "reasoning");
      return option && [option.currentValue, option.options.map((item: any) => item.value)];
    };
    const session = await agent.newSession();
    expect(reasoning(session)).toEqual(["default", ["default", "low", "medium", "high", "xhigh"]]);
    expect(session.configOptions.find((option) => option.id === "reasoning")?.options.at(-1)).toEqual({ value: "xhigh", name: "Extra high" });
    await agent.setConfigOption(session.sessionId, "reasoning", "xhigh");
    await agent.prompt(session.sessionId, [{ type: "text", text: "Go" }]);
    expect((requests.at(-1)!.body as any).reasoning_effort).toBe("xhigh");
    expect(reasoning(agent.setModel(session.sessionId, "model-b"))).toEqual(["default", ["default", "minimal", "low", "medium", "high"]]);
    await agent.setConfigOption(session.sessionId, "reasoning", "medium");
    expect(reasoning(await agent.setConfigOption(session.sessionId, "model", "model-a"))).toEqual(["medium", ["default", "low", "medium", "high", "xhigh"]]);
    const plain = await agent.setConfigOption(session.sessionId, "model", "model-c");
    expect(plain.configOptions.map((option) => option.id)).toEqual(["model", "mode"]);
    await expect(agent.setConfigOption(session.sessionId, "reasoning", "low")).rejects.toThrow("does not support that reasoning level");
    await agent.prompt(session.sessionId, [{ type: "text", text: "Again" }]);
    expect(requests.at(-1)!.body).not.toHaveProperty("reasoning_effort");
  });
  it("uses each API's levels for the same session flow", async () => {
    const anthropic = setup([], { "agentACP.oxbit.api": "anthropic", "agentACP.oxbit.model": "claude-opus-5-5" }, { data: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-4-5" }] });
    const { sessionId, configOptions } = await anthropic.agent.newSession();
    expect(configOptions.find((option) => option.id === "reasoning")?.options.map((item: any) => item.value)).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    await anthropic.agent.setConfigOption(sessionId, "reasoning", "max");
    expect(anthropic.agent.setModel(sessionId, "claude-haiku-4-5").configOptions.some((option) => option.id === "reasoning")).toBe(false);
    const openai = setup([], { "agentACP.oxbit.api": "openai", "agentACP.oxbit.model": "gpt-6-sol" }, { data: [{ id: "gpt-6-sol" }, { id: "gpt-6.1-sol" }] });
    const opened = await openai.agent.newSession();
    await openai.agent.setConfigOption(opened.sessionId, "reasoning", "none");
    const switched = openai.agent.setModel(opened.sessionId, "gpt-6.1-sol").configOptions.find((option) => option.id === "reasoning")!;
    expect([switched.currentValue, switched.options.map((item: any) => item.value)]).toEqual(["default", ["default", "low", "medium", "high", "xhigh", "max"]]);
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

describe("basePrompt", () => {
  it("tells a model without a shell that it cannot run commands", () => {
    expect(basePrompt("/root", true, false)).toContain("This host has no shell, so you cannot run commands, tests or builds.");
    expect(basePrompt("/root", true, true)).toContain("Run shell commands with bash.");
    expect(basePrompt("/root", true, true)).not.toContain("no shell");
  });
});
