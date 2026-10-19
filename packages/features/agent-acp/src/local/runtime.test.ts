import { describe, expect, it, vi } from "vitest";
import { MISSING_AGENT_KEY, MISSING_CHATGPT_SIGN_IN, type ACPConnection, type FeatureOptions, type Persistence } from "@oxbit/sdk";
import { LocalAgentRuntime } from "./runtime.js";
import { memoryPersistence } from "./sessions.js";
import type { AgentHost } from "@oxbit/agent-core";
import { chatText, chatTool, fakeModels, hanging, settings, type Reply } from "@oxbit/agent-core/test-models";
import { OXBIT_INSTRUCTIONS_SETTING } from "../configuration.js";

const EVENTS = ["acp.turnStarted", "acp.turnEnded", "acp.update", "acp.request", "acp.requestsExpired", "acp.cancelled", "acp.queue", "acp.exit", "acp.subagent"];
/** A workspace FileSystem over relative paths and file texts. */
function workspace(files: Record<string, string>) {
  const children = (dir: string) => {
    const names = new Map<string, "file" | "directory">();
    for (const path of Object.keys(files)) {
      if (dir && !path.startsWith(`${dir}/`)) continue;
      const [name, ...rest] = (dir ? path.slice(dir.length + 1) : path).split("/");
      names.set(name, rest.length ? "directory" : "file");
    }
    return [...names].map(([name, kind]) => ({ name, kind }));
  };
  return { id: "fs", root: "/root/", list: async (dir: string) => children(dir),
    read: async (path: string) => path in files ? { text: files[path] } : Promise.reject(new Error(`${path} not found`)) };
}
function setup(replies: Reply[] = [], key = true, { files = {}, persistence }: { files?: Record<string, string>; persistence?: Persistence } = {}) {
  const fake = fakeModels(replies, { key });
  const configuration = settings();
  const options = { kernel: { configuration }, filesystem: workspace(files), workbench: { persistence } } as unknown as FeatureOptions;
  let available = true;
  const runtime = new LocalAgentRuntime(options, () => available ? fake.models : undefined);
  const events: { name: string; params: Record<string, any> }[] = [];
  for (const name of EVENTS) runtime.subscribe(name, (params) => events.push({ name, params }));
  const connect = async () => {
    const started = await runtime.request<ACPConnection>("acp.start", { provider: "oxbit" });
    return runtime.request<ACPConnection>("acp.call", { id: started.id, method: "session/new" });
  };
  const named = (name: string) => events.filter((event) => event.name === name).map((event) => event.params);
  return { runtime, events, connect, named, configuration, unavailable: () => (available = false), ...fake };
}
/** The Agent host, to send the child-session traffic that the task tool sends. */
const agentHost = (runtime: LocalAgentRuntime, id: string): AgentHost => (runtime as any).connections.get(id).agent.host;
const prompt = (runtime: LocalAgentRuntime, id: string, messageId: string, text = "Hi") =>
  runtime.request<{ stopReason: string }>("acp.call", { id, method: "session/prompt", params: { text, messageId } });

describe("LocalAgentRuntime", () => {
  it("forks a session into a new one whose model requests keep the earlier turns", async () => {
    const { runtime, connect, requests } = setup([chatText("Noted"), chatText("Blue")]);
    const first = await connect();
    expect(first.capabilities?.sessionCapabilities?.fork).toEqual({});
    await prompt(runtime, first.id, "m1", "Remember the blue door");
    const forked = await runtime.request<ACPConnection>("acp.call", { id: first.id, method: "session/fork" });
    expect(forked.sessionId).not.toBe(first.sessionId);
    await prompt(runtime, first.id, "m2", "Which door?");
    const messages = (requests.at(-1)!.body as { messages: { role: string; content: string }[] }).messages;
    expect(messages.filter((message) => message.role !== "system").map((message) => message.content.replace(/\n\n<context-usage>.*<\/context-usage>$/, "")))
      .toEqual(["Remember the blue door", "Noted", "Which door?"]);
  });
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
  it("asks for a ChatGPT sign-in when the chatgpt endpoint has no tokens", async () => {
    const options = { kernel: { configuration: settings({ "agentACP.oxbit.api": "chatgpt" }) }, filesystem: { id: "fs", root: "/root/" } } as unknown as FeatureOptions;
    const runtime = new LocalAgentRuntime(options, () => fakeModels([], { key: false }).models);
    await expect(runtime.request("acp.start", { provider: "oxbit" })).rejects.toThrow(MISSING_CHATGPT_SIGN_IN);
  });
  it("forwards git methods to the workspace git client when there is one", async () => {
    const git = { connected: true, subscribe: () => () => {}, request: vi.fn(async () => ({ files: [] })) };
    const options = { kernel: { configuration: settings() }, filesystem: { id: "fs", root: "/root" }, git } as unknown as FeatureOptions;
    const runtime = new LocalAgentRuntime(options, () => fakeModels([]).models);
    expect(await runtime.request("git.status", { path: "." })).toEqual({ files: [] });
    expect(git.request).toHaveBeenCalledWith("git.status", { path: "." }, {});
    await expect(runtime.request("git.branchDiff", { limit: 0 })).rejects.toThrow("git.branchDiff needs a runtime workspace");
    expect(git.request).toHaveBeenCalledTimes(1);
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
  it("moves a queued prompt to a clamped index and runs the queue in the new order", async () => {
    const { runtime, connect, named } = setup([hanging(), chatText("C"), chatText("A"), chatText("B")]);
    const connection = await connect();
    const first = prompt(runtime, connection.id, "first");
    for (const id of ["a", "b", "c"]) await runtime.request("acp.enqueue", { id: connection.id, text: id.toUpperCase(), messageId: id });
    const move = (promptId: string, index: unknown) => runtime.request<{ queue: { id: string }[] }>("acp.moveQueued", { id: connection.id, promptId, index });
    expect((await move("c", -1)).queue.map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect((await move("b", 1)).queue.map((item) => item.id)).toEqual(["c", "b", "a"]);
    expect((await move("b", 9)).queue.map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(named("acp.queue").at(-1)!.queue.map((item: { id: string }) => item.id)).toEqual(["c", "a", "b"]);
    await expect(move("missing", 0)).rejects.toThrow("The queued message has already started or was removed");
    await expect(move("a", 0.5)).rejects.toThrow("Invalid index");
    await runtime.request("acp.cancel", { id: connection.id });
    expect(await first).toEqual({ stopReason: "cancelled" });
    await runtime.request("acp.resumeQueue", { id: connection.id });
    await expect.poll(() => named("acp.turnEnded").length).toBe(4);
    expect(named("acp.turnStarted").map((event) => event.messageId)).toEqual(["first", "c", "a", "b"]);
    await expect(move("c", 0)).rejects.toThrow("already started");
  });
  it("lists compaction, goal, loop, config and workspace skill commands, and reads AGENTS.md", async () => {
    const files = { "AGENTS.md": "Use tabs.", ".agents/skills/review/SKILL.md": "---\nname: review\ndescription: Review the diff\n---\nReview it.",
      ".claude/skills/ship/SKILL.md": "---\nname: ship\ndescription: Ship it\n---\nShip." };
    const { runtime, connect, named, requests } = setup([chatText("Ok")], true, { files });
    const connection = await connect();
    expect(connection.capabilities).toEqual(expect.objectContaining({ loadSession: true, sessionCapabilities: expect.objectContaining({ list: {} }) }));
    const commands = () => named("acp.update").filter((event) => event.update.sessionUpdate === "available_commands_update").at(-1)?.update.availableCommands
      .map((command: { name: string }) => command.name) ?? [];
    await expect.poll(commands).toEqual(expect.arrayContaining(["context", "compact", "goal", "loop", "config", "skills", "review", "ship"]));
    await prompt(runtime, connection.id, "m");
    const system = (requests.at(-1)!.body as { messages: { role: string; content: string }[] }).messages[0].content;
    expect(system).toContain("Use tabs.");
    expect(system).toContain("Review the diff");
  });
  it("saves sessions to host storage, lists them and loads one into a new runtime", async () => {
    const persistence = memoryPersistence();
    const first = setup([chatText("Noted")], true, { persistence });
    const original = await first.connect();
    await prompt(first.runtime, original.id, "m1", "Remember the blue door");
    const second = setup([chatText("Blue")], true, { persistence });
    const started = await second.runtime.request<ACPConnection>("acp.start", { provider: "oxbit" });
    const call = (method: string, params?: object) => second.runtime.request<any>("acp.call", { id: started.id, method, params });
    expect((await call("session/list")).sessions).toEqual([expect.objectContaining({ sessionId: original.sessionId, cwd: "/root" })]);
    const loaded = await call("session/load", { sessionId: original.sessionId });
    expect(loaded.sessionId).toBe(original.sessionId);
    expect(second.named("acp.update").map((event) => [event.rootSessionId, event.update.sessionUpdate, event.update.content?.text]))
      .toEqual(expect.arrayContaining([[original.sessionId, "user_message_chunk", "Remember the blue door"], [original.sessionId, "agent_message_chunk", "Noted"]]));
    await prompt(second.runtime, started.id, "m2", "Which door?");
    const messages = (second.requests.at(-1)!.body as { messages: { role: string; content: unknown }[] }).messages;
    expect(messages.filter((message) => message.role !== "system").map((message) => message.content))
      .toEqual(["Remember the blue door", "Noted", "Which door?"]);
    await expect(call("session/load", { sessionId: "missing" })).rejects.toThrow();
    expect((await call("session/list")).sessions).toHaveLength(1);
  });
  it("changes compaction settings with /config and sends config_option_update", async () => {
    const { runtime, connect, named, configuration } = setup();
    const connection = await connect();
    expect(connection.configOptions?.find((option) => option.id === "auto-compact")?.currentValue).toBe("on");
    expect(await prompt(runtime, connection.id, "m", "/config auto-compact off")).toEqual({ stopReason: "end_turn" });
    expect(configuration.store["agentACP.oxbit.autoCompact"]).toBe(false);
    const update = named("acp.update").find((event) => event.update.sessionUpdate === "config_option_update")!.update;
    expect(update.configOptions.find((option: { id: string }) => option.id === "auto-compact").currentValue).toBe("off");
  });
  it("resumes a paused queue when a prompt is sent directly", async () => {
    const { runtime, connect, named } = setup([hanging(), chatText("Now"), chatText("Later")]);
    const connection = await connect();
    const first = prompt(runtime, connection.id, "first");
    await runtime.request("acp.enqueue", { id: connection.id, text: "Later", messageId: "later" });
    await runtime.request("acp.cancel", { id: connection.id });
    expect(await first).toEqual({ stopReason: "cancelled" });
    expect(named("acp.queue").at(-1)).toEqual(expect.objectContaining({ paused: true }));
    expect(await prompt(runtime, connection.id, "now", "Now")).toEqual({ stopReason: "end_turn" });
    await expect.poll(() => named("acp.turnStarted").map((event) => event.messageId)).toEqual(["first", "now", "later"]);
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
  it("cancels running turns when disposed", async () => {
    const { runtime, connect, named } = setup([hanging()]);
    const connection = await connect();
    const turn = prompt(runtime, connection.id, "m");
    runtime.dispose();
    expect(await turn).toEqual({ stopReason: "cancelled" });
    expect(named("acp.exit")).toEqual([expect.objectContaining({ id: connection.id, reason: "Workspace closed" })]);
  });
  it("advertises child sessions and routes a child's updates and requests through the subagent registry", async () => {
    const { runtime, connect, named } = setup();
    const connection = await connect();
    const root = connection.sessionId!;
    const host = agentHost(runtime, connection.id);
    expect(host.capabilities.childSessions).toBe(true);
    expect(host.subagents).toEqual({});
    host.update(root, { sessionUpdate: "subagent_spawned", subagentSessionId: "C", name: "Review", task: "Inspect a.ts" });
    host.update("C", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking" } });
    host.update("Z", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Stray" } });
    expect(named("acp.update").filter((event) => event.sessionId !== root)).toEqual([
      expect.objectContaining({ rootSessionId: root, sessionId: "C", update: expect.objectContaining({ sessionUpdate: "agent_message_chunk" }) })]);
    expect(named("acp.subagent").at(-1)).toEqual(expect.objectContaining({ rootSessionId: root, activeCount: 1,
      subagent: expect.objectContaining({ id: "oxbit:C", provider: "oxbit", name: "Review", state: "running", result: "Looking" }) }));
    const write = host.request("fs/write_text_file", { sessionId: "C", toolCallId: "t1", path: "/root/a.ts", content: "x" });
    await expect(host.request("fs/read_text_file", { sessionId: "Z", path: "/root/a.ts" })).rejects.toThrow("Unknown ACP session");
    const request = named("acp.request").at(-1)!;
    expect(request).toEqual(expect.objectContaining({ sessionId: "C", rootSessionId: root, subagentId: "oxbit:C", method: "fs/write_text_file" }));
    expect(named("acp.subagent").at(-1)!.subagent.phase).toBe("awaiting_input");
    await expect(runtime.request("acp.call", { id: connection.id, method: "session/new" })).rejects.toThrow("Wait for active subagents");
    host.update(root, { sessionUpdate: "subagent_state_update", subagentSessionId: "C", state: "completed" });
    await expect(write).rejects.toThrow("Session turn ended");
    expect(named("acp.requestsExpired")).toEqual([expect.objectContaining({ requestIds: [request.requestId] })]);
    expect(named("acp.subagent").at(-1)).toEqual(expect.objectContaining({ activeCount: 0, subagent: expect.objectContaining({ state: "completed" }) }));
    await expect(host.request("fs/read_text_file", { sessionId: "C", path: "/root/a.ts" })).rejects.toThrow("Unknown ACP session");
    const next = await runtime.request<ACPConnection>("acp.call", { id: connection.id, method: "session/new" });
    host.update("C", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Late" } });
    expect(named("acp.update").some((event) => event.update.content?.text === "Late")).toBe(false);
    expect(next.sessionId).not.toBe(root);
  });
  it("attributes fallback child cards and their permission requests to the task call", async () => {
    const { runtime, connect, named } = setup();
    const connection = await connect();
    const root = connection.sessionId!;
    const host = agentHost(runtime, connection.id);
    host.update(root, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Agent: Review", kind: "other", status: "in_progress",
      _meta: { oxbit: { subagent: { name: "Review", task: "Inspect a.ts", state: "running" } } } });
    host.update(root, { sessionUpdate: "tool_call", toolCallId: "call_1/c1", title: "Edit a.ts", kind: "edit", status: "pending",
      _meta: { oxbit: { subagentOf: "call_1" } } });
    const id = `tool:${JSON.stringify([root, "call_1"])}`;
    const permission = host.request("session/request_permission", { sessionId: root, toolCall: { toolCallId: "call_1/c1" }, options: [] });
    const request = named("acp.request").at(-1)!;
    expect(request).toEqual(expect.objectContaining({ sessionId: root, subagentId: id }));
    expect(named("acp.subagent").at(-1)!.subagent).toEqual(expect.objectContaining({ id, phase: "awaiting_input", state: "running" }));
    await runtime.request("acp.respond", { id: connection.id, requestId: request.requestId, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(await permission).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(named("acp.subagent").at(-1)!.subagent.phase).toBe("unknown");
    await runtime.request("acp.stop", { id: connection.id });
    expect(named("acp.subagent").at(-1)).toEqual(expect.objectContaining({ activeCount: 0, subagent: expect.objectContaining({ id, state: "disconnected" }) }));
  });
  it("fills context limits from the built-in table for listed OpenAI models", async () => {
    const fake = fakeModels([], { list: { data: [{ id: "gpt-5.5" }, { id: "custom-model" }] } });
    const configuration = settings({ "agentACP.oxbit.api": "openai" });
    const options = { kernel: { configuration }, filesystem: workspace({}), workbench: {} } as unknown as FeatureOptions;
    const runtime = new LocalAgentRuntime(options, () => fake.models);
    const started = await runtime.request<ACPConnection>("acp.start", { provider: "oxbit" });
    const catalog = await agentHost(runtime, started.id).catalog!();
    expect(catalog.find((model) => model.id === "gpt-5.5")?.contextWindow).toBeGreaterThan(0);
    expect(catalog.find((model) => model.id === "custom-model")?.contextWindow).toBeUndefined();
  });
  it("sends the instructions setting and offers find_files when the filesystem can find files", async () => {
    const { runtime, connect, requests, configuration } = setup([chatText("Done")]);
    configuration.set(OXBIT_INSTRUCTIONS_SETTING, "Answer in haiku.");
    ((runtime as any).options.filesystem as Record<string, unknown>).findFiles = async () => ["src/a.ts"];
    const session = await connect();
    await prompt(runtime, session.id, "m1");
    const body = requests.at(-1)!.body as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };
    expect(body.messages[0].content).toContain("Answer in haiku.");
    expect(body.tools.map((tool) => tool.function.name)).toContain("find_files");
  });
});
