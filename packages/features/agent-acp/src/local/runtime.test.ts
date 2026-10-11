import { describe, expect, it, vi } from "vitest";
import { MISSING_AGENT_KEY, type ACPConnection, type FeatureOptions } from "@oxbit/sdk";
import { LocalAgentRuntime } from "./runtime.js";
import { chatText, chatTool, fakeModels, hanging, settings, type Reply } from "./test-models.js";

const EVENTS = ["acp.turnStarted", "acp.turnEnded", "acp.update", "acp.request", "acp.requestsExpired", "acp.cancelled", "acp.queue", "acp.exit"];
function setup(replies: Reply[] = [], key = true) {
  const fake = fakeModels(replies, { key });
  const options = { kernel: { configuration: settings() }, filesystem: { id: "fs", root: "/root/", list: async () => [] } } as unknown as FeatureOptions;
  let available = true;
  const runtime = new LocalAgentRuntime(options, () => available ? fake.models : undefined);
  const events: { name: string; params: Record<string, any> }[] = [];
  for (const name of EVENTS) runtime.subscribe(name, (params) => events.push({ name, params }));
  const connect = async () => {
    const started = await runtime.request<ACPConnection>("acp.start", { provider: "oxbit" });
    return runtime.request<ACPConnection>("acp.call", { id: started.id, method: "session/new" });
  };
  const named = (name: string) => events.filter((event) => event.name === name).map((event) => event.params);
  return { runtime, events, connect, named, unavailable: () => (available = false), ...fake };
}
const prompt = (runtime: LocalAgentRuntime, id: string, messageId: string, text = "Hi") =>
  runtime.request<{ stopReason: string }>("acp.call", { id, method: "session/prompt", params: { text, messageId } });

describe("LocalAgentRuntime", () => {
  it("rejects start without a key and answers unavailable runtime methods", async () => {
    const { runtime, unavailable } = setup([], false);
    expect(runtime.local).toBe(true);
    await expect(runtime.request("acp.start", { provider: "oxbit" })).rejects.toThrow(MISSING_AGENT_KEY);
    await expect(runtime.request("acp.list")).rejects.toThrow("acp.list needs a runtime workspace");
    await expect(runtime.request("git.status")).rejects.toThrow("git.status needs a runtime workspace");
    await expect(runtime.request("acp.start", { provider: "codex" })).rejects.toThrow("acp.start needs a runtime workspace");
    expect(await runtime.request("acp.checkpoint.create")).toEqual({ unavailable: "failed" });
    expect(await runtime.request("acp.registry")).toEqual(expect.objectContaining({ agents: [], fetchedAt: expect.any(String), error: expect.any(String) }));
    expect(runtime.connected).toBe(true);
    unavailable();
    expect(runtime.connected).toBe(false);
  });
  it("forwards git methods to the workspace git client when there is one", async () => {
    const git = { connected: true, subscribe: () => () => {}, request: vi.fn(async () => ({ files: [] })) };
    const options = { kernel: { configuration: settings() }, filesystem: { id: "fs", root: "/root" }, git } as unknown as FeatureOptions;
    const runtime = new LocalAgentRuntime(options, () => fakeModels([]).models);
    expect(await runtime.request("git.status", { path: "." })).toEqual({ files: [] });
    expect(git.request).toHaveBeenCalledWith("git.status", { path: "." }, {});
    await expect(setup().runtime.request("git.diff", { path: "a.ts" })).rejects.toThrow("git.diff needs a runtime workspace");
  });
  it("starts an Oxbit connection and tags turn events with its id, a rising seq and the prompt's messageId", async () => {
    const { runtime, events, connect, named } = setup([chatText("Hello")]);
    const connection = await connect();
    expect(connection).toEqual(expect.objectContaining({ provider: "oxbit", name: "Oxbit Agent", root: "/root", sessionId: expect.any(String),
      capabilities: expect.objectContaining({ promptCapabilities: { embeddedContext: true } }) }));
    expect(await prompt(runtime, connection.id, "message-1")).toEqual({ stopReason: "end_turn" });
    expect(named("acp.turnStarted")).toEqual([expect.objectContaining({ id: connection.id, messageId: "message-1", text: "Hi" })]);
    expect(named("acp.update")[0]).toEqual(expect.objectContaining({ sessionId: connection.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } }));
    expect(named("acp.turnEnded")).toEqual([expect.objectContaining({ stopReason: "end_turn", error: undefined })]);
    expect(events.every((event) => event.params.id === connection.id)).toBe(true);
    expect(events.map((event) => event.params.seq)).toEqual(events.map((_, index) => index + 1));
  });
  it("routes file reads through acp.request with workspace-relative paths and acp.respond", async () => {
    const { runtime, connect, named } = setup([chatTool("call_1", "read_file", { path: "src/a.ts" }), chatText("Read")]);
    const connection = await connect();
    const turn = prompt(runtime, connection.id, "m");
    await expect.poll(() => named("acp.request").length).toBe(1);
    const [request] = named("acp.request");
    expect(request).toEqual(expect.objectContaining({ method: "fs/read_text_file", sessionId: connection.sessionId,
      params: expect.objectContaining({ path: "src/a.ts", sessionId: connection.sessionId, toolCallId: "call_1" }) }));
    await runtime.request("acp.respond", { id: connection.id, requestId: request.requestId, result: { content: "A" } });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    await expect(runtime.request("acp.respond", { id: connection.id, requestId: request.requestId, result: {} })).rejects.toThrow("Agent request has expired");
  });
  it("cancels a pending write review and pauses the queue", async () => {
    const { runtime, connect, named } = setup([chatTool("call_1", "write_file", { path: "a.ts", content: "x" }), hanging()]);
    const connection = await connect();
    const turn = prompt(runtime, connection.id, "m");
    await expect.poll(() => named("acp.request").map((request) => request.method)).toEqual(["fs/read_text_file"]);
    await runtime.request("acp.respond", { id: connection.id, requestId: named("acp.request")[0].requestId, error: "Missing" });
    await expect.poll(() => named("acp.request").length).toBe(2);
    await runtime.request("acp.enqueue", { id: connection.id, text: "Later", messageId: "later" });
    expect(await runtime.request("acp.cancel", { id: connection.id })).toEqual({});
    expect(await turn).toEqual({ stopReason: "cancelled" });
    expect(named("acp.cancelled")).toHaveLength(1);
    expect(named("acp.queue").at(-1)).toEqual(expect.objectContaining({ paused: true, queue: [{ id: "later", text: "Later" }] }));
    await expect(runtime.request("acp.respond", { id: connection.id, requestId: named("acp.request")[1].requestId, result: null })).rejects.toThrow("expired");
  });
  it("queues, dequeues and interrupts with the runtime's semantics", async () => {
    const { runtime, connect, named } = setup([hanging(), chatText("C"), chatText("A")]);
    const connection = await connect();
    const first = prompt(runtime, connection.id, "first");
    await runtime.request("acp.enqueue", { id: connection.id, text: "A", messageId: "a" });
    expect(await runtime.request("acp.enqueue", { id: connection.id, text: "B", messageId: "b" })).toEqual({ queue: [{ id: "a", text: "A" }, { id: "b", text: "B" }], paused: false });
    expect(await runtime.request("acp.dequeue", { id: connection.id, promptId: "b" })).toEqual({ prompt: { id: "b", text: "B" } });
    expect(await runtime.request("acp.interrupt", { id: connection.id, text: "C", messageId: "c" })).toEqual({ queue: [{ id: "c", text: "C" }, { id: "a", text: "A" }], paused: false });
    expect(await first).toEqual({ stopReason: "cancelled" });
    await expect.poll(() => named("acp.turnEnded").length).toBe(3);
    expect(named("acp.turnStarted").map((event) => event.messageId)).toEqual(["first", "c", "a"]);
    await expect(runtime.request("acp.dequeue", { id: connection.id, promptId: "c" })).rejects.toThrow("already started or was removed");
  });
  it("stops a connection with acp.exit and rejects later calls", async () => {
    const { runtime, connect, named } = setup([hanging()]);
    const connection = await connect();
    const turn = prompt(runtime, connection.id, "m");
    await runtime.request("acp.stop", { id: connection.id });
    expect(await turn).toEqual({ stopReason: "cancelled" });
    expect(named("acp.exit")).toEqual([expect.objectContaining({ id: connection.id, reason: "Agent disconnected" })]);
    expect(named("acp.turnEnded")).toEqual([]);
    await expect(prompt(runtime, connection.id, "n")).rejects.toThrow("Agent connection has ended");
  });
});
