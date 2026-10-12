import { describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import type { AgentCommand, SessionRecord, SessionStore } from "./extensions.js";
import { chatText, chatTool } from "./test-models.js";
import { hooks, start, testHost, text } from "./test-host.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function memoryStore() {
  const records = new Map<string, SessionRecord>();
  const store: SessionStore = {
    save: vi.fn(async (record: SessionRecord) => void records.set(record.id, structuredClone(record))),
    load: async (id) => structuredClone(records.get(id)),
    list: async (cwd) => [...records.values()].filter((record) => record.cwd === cwd).map(({ turns: _turns, ...rest }) => rest),
  };
  return { store, records };
}

describe("Agent sessions", () => {
  it("saves after each turn, then loads with a replay and lists by cwd", async () => {
    const { store, records } = memoryStore();
    const first = testHost([chatTool("call_1", "read_file", { path: "a.ts" }), chatText("Read it")], { extensions: { sessions: store }, files: { "/root/a.ts": "A" } });
    const agent = new Agent(first.host);
    expect(agent.initialize().agentCapabilities).toEqual(expect.objectContaining({ loadSession: true, sessionCapabilities: { fork: {}, list: {} } }));
    const sessionId = await start(agent, { mcpServers: [{ name: "docs", command: "docs-mcp", args: [], env: [] }] });
    await agent.prompt(sessionId, text("Hello there\nmore"));
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(records.get(sessionId)).toEqual(expect.objectContaining({ cwd: "/root", title: "Hello there", model: "model-a",
      meta: { mode: "ask", mcpServers: [{ name: "docs", command: "docs-mcp", args: [], env: [] }] } }));
    const second = testHost([chatText("Again")], { extensions: { sessions: store } });
    const loaded = new Agent(second.host);
    expect(await loaded.loadSession({ sessionId, cwd: "/root", mcpServers: [] })).toEqual(expect.objectContaining({ sessionId,
      modes: expect.objectContaining({ currentModeId: "ask" }) }));
    expect(second.updates.map((update) => [update.sessionUpdate, update.content?.text ?? update.title ?? update.status])).toEqual([
      ["user_message_chunk", "Hello there\nmore"], ["tool_call", "Read a.ts"], ["tool_call_update", "completed"], ["agent_message_chunk", "Read it"],
    ]);
    expect(await loaded.listSessions({ cwd: "/root/" })).toEqual({ sessions: [{ sessionId, cwd: "/root", title: "Hello there", updatedAt: expect.any(String) }] });
    await loaded.prompt(sessionId, text("Next"));
    expect(second.messages().map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
  });
  it("advertises loadSession only with a SessionStore and keeps other sessions with one", async () => {
    const plain = new Agent(testHost([]).host);
    expect(plain.initialize().agentCapabilities).toEqual(expect.objectContaining({ loadSession: false, sessionCapabilities: { fork: {} } }));
    const first = await start(plain);
    await start(plain);
    await expect(plain.prompt(first, text("Hi"))).rejects.toThrow("Unknown ACP session");
    const kept = new Agent(testHost([chatText("Hi")], { extensions: { sessions: memoryStore().store } }).host);
    const old = await start(kept);
    await start(kept);
    expect(await kept.prompt(old, text("Hi"))).toEqual({ stopReason: "end_turn" });
  });
  it("runs SessionStart with its context in the system prompt and SessionEnd on dispose", async () => {
    const { runner, calls } = hooks((event) => event === "SessionStart" ? { additionalContext: "Branch: main" } : undefined);
    const t = testHost([chatText("Ok")], { extensions: { hooks: runner, context: [{ system: async (session) => `Cwd: ${session.cwd}` }] } });
    const agent = new Agent(t.host);
    await agent.prompt(await start(agent), text("Hi"));
    expect(t.messages()[0].content).toMatch(/Use update_plan[^\n]*\n\nBranch: main\n\nCwd: \/root$/);
    await agent.dispose();
    expect(calls.map(([event, input]) => [event, input.source ?? input.reason])).toEqual([["SessionStart", "startup"], ["UserPromptSubmit", undefined],
      ["Stop", undefined], ["SessionEnd", "other"]]);
  });
  it("dispatches slash commands and publishes available_commands_update when the list changes", async () => {
    const run = vi.fn<AgentCommand["run"]>(async (args) => ({ prompt: `Say hello to ${args}` }));
    const status: AgentCommand = { name: "status", description: "Show status", run: async (_args, context) => {
      context.session.meta.status = true;
      return { done: "end_turn" };
    } };
    const commands = { commands: (session: { meta: Record<string, unknown> }) => [{ name: "greet", description: "Greet someone", hint: "name", run },
      status, ...session.meta.status ? [{ name: "reset", description: "Reset status", run }] : []] };
    const t = testHost([chatText("Hello Bob"), chatText("Path")], { extensions: { commands: [commands] } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await tick();
    expect(t.updates).toEqual([{ sessionUpdate: "available_commands_update", availableCommands: [
      { name: "greet", description: "Greet someone", input: { hint: "name" } }, { name: "status", description: "Show status" }] }]);
    await agent.prompt(sessionId, text("/greet Bob"));
    expect(run).toHaveBeenCalledWith("Bob", expect.objectContaining({ session: expect.objectContaining({ id: sessionId }) }));
    expect(t.messages().at(-1)).toEqual({ role: "user", content: "Say hello to Bob" });
    expect(await agent.prompt(sessionId, text("/status"))).toEqual({ stopReason: "end_turn" });
    expect(t.posts()).toHaveLength(1);
    expect(t.updates.at(-1)!.availableCommands.map((command: { name: string }) => command.name)).toEqual(["greet", "status", "reset"]);
    await agent.prompt(sessionId, text("/etc/hosts is missing"));
    expect(t.messages().at(-1)).toEqual({ role: "user", content: "/etc/hosts is missing" });
  });
  it("offers tool provider tools per step and keeps built-in names", async () => {
    const echo = { spec: { name: "echo", description: "Echo", parameters: { type: "object" } }, kind: "other" as const, title: () => "Echo",
      run: async (args: Record<string, unknown>) => `echo ${args.text}` };
    const shadow = { ...echo, spec: { ...echo.spec, name: "read_file" } };
    const t = testHost([chatTool("call_1", "echo", { text: "hi" }), chatText("Ok")], { extensions: { tools: [{ tools: () => [echo, shadow] }] } });
    const agent = new Agent(t.host);
    await agent.prompt(await start(agent), text("Echo"));
    const names = (t.posts()[0].body as any).tools.map((tool: any) => tool.function.name);
    expect(names).toEqual(["list_files", "search", "read_file", "write_file", "edit_file", "diagnostics", "update_plan", "echo"]);
    expect(t.messages().at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "echo hi" });
  });
  it("honors the session cwd for tool paths and listing", async () => {
    const list = vi.fn(async () => [{ path: "x.ts", name: "x.ts", kind: "file" }]);
    const t = testHost([chatTool("call_1", "read_file", { path: "a.ts" }), chatTool("call_2", "list_files", {}), chatText("Ok")],
      { host: { filesystemFor: (cwd) => ({ id: cwd, list }) as any } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent, { cwd: "/work/app/" });
    await agent.prompt(sessionId, text("Read"));
    expect(t.client).toEqual([["fs/read_text_file", expect.objectContaining({ path: "/work/app/a.ts" })]]);
    expect(list).toHaveBeenCalledWith("");
    expect(t.messages()[0].content).toContain('workspace "app"');
    const strict = new Agent(testHost([]).host);
    await expect(strict.newSession({ cwd: "/work/app" })).rejects.toThrow("serves /root only");
    await expect(strict.newSession({ cwd: "relative" })).rejects.toThrow("absolute path");
  });
});

describe("Agent modes and titles", () => {
  it("advertises modes, switches them with current_mode_update and marks auto-applied writes", async () => {
    const t = testHost([chatTool("call_1", "write_file", { path: "a.ts", content: "x" }), chatText("Ok")], { extensions: { sessions: memoryStore().store } });
    const agent = new Agent(t.host);
    const session = await agent.newSession();
    expect(session.modes).toEqual({ currentModeId: "ask", availableModes: [expect.objectContaining({ id: "ask" }),
      expect.objectContaining({ id: "accept-edits" }), expect.objectContaining({ id: "full-auto" })] });
    await expect(agent.handle("session/set_mode", { sessionId: session.sessionId, modeId: "yolo" })).rejects.toThrow("Unknown agent mode");
    expect(await agent.handle("session/set_mode", { sessionId: session.sessionId, modeId: "accept-edits" })).toEqual({});
    expect(t.updates.at(-1)).toEqual({ sessionUpdate: "current_mode_update", currentModeId: "accept-edits" });
    await agent.prompt(session.sessionId, text("Write"));
    expect(t.client.at(-1)).toEqual(["fs/write_text_file", expect.objectContaining({ content: "x", _meta: { oxbit: { mode: "accept-edits" } } })]);
    const result = agent.setConfigOption(session.sessionId, "mode", "full-auto");
    expect(result.configOptions.find((option) => option.id === "mode")?.currentValue).toBe("full-auto");
  });
  it("asks before execute tools unless the mode is full-auto", async () => {
    const terminal = (method: string) => method === "terminal/create" ? { terminalId: "t1" } : method === "terminal/wait_for_exit" ? { exitCode: 0, signal: null }
      : method === "terminal/output" ? { output: "ok", truncated: false } : method === "session/request_permission" ? { outcome: { outcome: "cancelled" } } : undefined;
    const t = testHost([chatTool("call_1", "bash", { command: "ls" }), chatText("Ok"), chatTool("call_2", "bash", { command: "ls" }), chatText("Ok")],
      { terminal: true, respond: terminal });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("List"));
    expect(t.client.map(([method]) => method)).toEqual(["session/request_permission"]);
    expect(t.messages().at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "The user denied this tool call" });
    agent.setMode(sessionId, "full-auto");
    await agent.prompt(sessionId, text("List"));
    expect(t.client.slice(1).map(([method]) => method)).toEqual(["terminal/create", "terminal/wait_for_exit", "terminal/output", "terminal/release"]);
    expect(t.messages().at(-1)).toEqual({ role: "tool", tool_call_id: "call_2", content: "ok\n[Exit code 0]" });
  });
  it("titles a session after its first finished turn and stays silent on failure", async () => {
    const { store, records } = memoryStore();
    const t = testHost([chatText("Fixed the login redirect"), chatText("\"Fix login redirect bug.\""), chatText("Again")],
      { extensions: { sessions: store }, host: { generateTitles: true } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("The login page loops"));
    await expect.poll(() => t.updates.at(-1)).toEqual({ sessionUpdate: "session_info_update", title: "Fix login redirect bug" });
    const request = t.posts()[1].body as any;
    expect(request.messages).toEqual([{ role: "system", content: "Write a 3 to 7 word title for this coding conversation. Reply with the title only." },
      { role: "user", content: "User: The login page loops\n\nAssistant: Fixed the login redirect" }]);
    expect(request.tools).toBeUndefined();
    await expect.poll(() => records.get(sessionId)?.title).toBe("Fix login redirect bug");
    await agent.prompt(sessionId, text("More"));
    expect(t.posts()).toHaveLength(3);
    const failing = testHost([chatText("Hi")], { host: { generateTitles: true } });
    const quiet = new Agent(failing.host);
    await quiet.prompt(await start(quiet), text("Hi"));
    await tick();
    expect(failing.updates.map((update) => update.sessionUpdate)).toEqual(["agent_message_chunk", "usage_update"]);
  });
});
