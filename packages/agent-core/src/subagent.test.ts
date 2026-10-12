import { describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import type { Params, SessionRecord, SnapshotStore } from "./extensions.js";
import { SUBAGENT_PROMPT } from "./subagent.js";
import { chatText, chatTool, chatTools, hanging, type Reply } from "./test-models.js";
import { hooks, start, testHost, text, type HostOptions } from "./test-host.js";

const task = (id: string, prompt = "Look for X") => chatTool(id, "task", { description: "Find the thing", prompt });
const until = async (check: () => boolean) => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 1));
};

/** testHost with subagents on and update recorded with its sessionId. */
function subagentHost(replies: Reply[], options: HostOptions & { childSessions?: boolean } = {}) {
  const sent: [string, Params][] = [];
  const t = testHost(replies, { ...options, host: { subagents: {}, update: (sessionId, update) => void sent.push([sessionId, update]), ...options.host } });
  t.host.capabilities.childSessions = options.childSessions;
  const metaStates = () => sent.filter(([, update]) => update.sessionUpdate === "tool_call_update" && update._meta?.oxbit?.subagent)
    .map(([, update]) => update._meta.oxbit.subagent.state);
  return { ...t, sent, metaStates };
}

describe("task tool", () => {
  it("runs the child with a fresh context and returns its last message", async () => {
    const t = subagentHost([task("t1"), chatText("Found X in a.ts"), chatText("Done")]);
    const agent = new Agent(t.host);
    expect(agent.initialize().agentCapabilities.sessionCapabilities).toEqual({ fork: {}, subagents: {} });
    const sessionId = await start(agent);
    expect(await agent.prompt(sessionId, text("Find X"))).toEqual({ stopReason: "end_turn" });
    const bodies = t.posts().map((post) => post.body as Params);
    expect(bodies[0].tools.map((tool: Params) => tool.function.name)).toContain("task");
    expect(bodies[1].tools.map((tool: Params) => tool.function.name)).not.toContain("task");
    expect(bodies[1].model).toBe("model-a");
    expect(bodies[1].messages).toEqual([{ role: "system", content: expect.stringContaining(SUBAGENT_PROMPT) }, { role: "user", content: "Look for X" }]);
    expect(bodies[0].messages[0].content).not.toContain(SUBAGENT_PROMPT);
    expect(t.messages().at(-1)).toEqual({ role: "tool", tool_call_id: "t1", content: "Found X in a.ts" });
    expect(t.sent.find(([, update]) => update.sessionUpdate === "tool_call")).toEqual([sessionId, expect.objectContaining({ toolCallId: "t1",
      title: "Task: Find the thing", kind: "other", _meta: { oxbit: { subagent: { name: "Find the thing", task: "Look for X", model: "model-a", state: "pending" } } } })]);
    expect(t.metaStates()).toEqual(["running", "completed"]);
  });

  it("forwards child tool calls on the parent session without a child-session client", async () => {
    const t = subagentHost([task("t1"), chatTool("c1", "write_file", { path: "a.ts", content: "x" }), chatText("Wrote a.ts"), chatText("Done")]);
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("Write"));
    expect(t.sent.every(([id]) => id === sessionId)).toBe(true);
    expect(t.sent.map(([, update]) => update)).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "t1/c1", title: "Write a.ts",
      _meta: { oxbit: { subagentOf: "t1" } } }));
    expect(t.sent.some(([, update]) => update.content?.text === "Wrote a.ts")).toBe(false);
    expect(t.client.at(-1)).toEqual(["fs/write_text_file", { sessionId, toolCallId: "t1/c1", path: "/root/a.ts", content: "x" }]);
    expect(t.client.some(([method]) => method === "session/request_permission")).toBe(false);
    expect(t.files).toEqual({ "/root/a.ts": "x" });
  });

  it("sends child updates and requests on the child session for a child-session client", async () => {
    const t = subagentHost([task("t1"), chatTool("c1", "write_file", { path: "a.ts", content: "x" }), chatText("Wrote a.ts"), chatText("Done")], { childSessions: true });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("Write"));
    const childId = t.sent.find(([, update]) => update.sessionUpdate === "subagent_spawned")![1].subagentSessionId;
    const flow = t.sent.filter(([id, update]) => id === childId ? update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "tool_call"
      : ["subagent_spawned", "subagent_state_update"].includes(update.sessionUpdate) || update._meta?.oxbit?.subagent && update.sessionUpdate === "tool_call_update");
    expect(flow).toEqual([
      [sessionId, { sessionUpdate: "subagent_spawned", subagentSessionId: childId, name: "Find the thing", task: "Look for X" }],
      [childId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Look for X" } }],
      [sessionId, expect.objectContaining({ toolCallId: "t1", _meta: { oxbit: { subagent: expect.objectContaining({ sessionId: childId, state: "running" }) } } })],
      [childId, expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "c1" })],
      [sessionId, { sessionUpdate: "subagent_state_update", subagentSessionId: childId, state: "completed" }],
      [sessionId, expect.objectContaining({ toolCallId: "t1", _meta: { oxbit: { subagent: expect.objectContaining({ sessionId: childId, state: "completed" }) } } })],
    ]);
    expect(t.client.at(-1)).toEqual(["fs/write_text_file", { sessionId: childId, toolCallId: "c1", path: "/root/a.ts", content: "x" }]);
  });

  it("runs several task calls from one response at the same time", async () => {
    let running = 0;
    const child: Reply = async function* () {
      running++;
      await until(() => running === 2);
      yield* chatText("Child done");
    };
    const t = subagentHost([chatTools(["t1", "task", { description: "One", prompt: "A" }], ["t2", "task", { description: "Two", prompt: "B" }]), child, child, chatText("Done")]);
    const agent = new Agent(t.host);
    await agent.prompt(await start(agent), text("Both"));
    expect(t.messages().slice(-2)).toEqual([{ role: "tool", tool_call_id: "t1", content: "Child done" }, { role: "tool", tool_call_id: "t2", content: "Child done" }]);
  });

  it("cancels a child waiting on a permission prompt and reports the cancelled state", async () => {
    const t = subagentHost([task("t1"), chatTool("c1", "bash", { command: "ls" }), hanging()], {
      terminal: true, childSessions: true, respond: (method) => method === "session/request_permission" ? new Promise(() => {}) : undefined,
    });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    const prompt = agent.prompt(sessionId, text("List"));
    await until(() => t.client.some(([method]) => method === "session/request_permission"));
    agent.cancel(sessionId);
    expect(await prompt).toEqual({ stopReason: "cancelled" });
    expect(t.sent.map(([, update]) => update)).toContainEqual(expect.objectContaining({ sessionUpdate: "subagent_state_update", state: "cancelled" }));
    expect(t.metaStates()).toEqual(["running", "cancelled"]);
    expect(t.sent.map(([, update]) => update)).toContainEqual(expect.objectContaining({ toolCallId: "t1", status: "failed", rawOutput: "Cancelled by the user" }));
  });

  it("forwards tool hooks with the parent's session_id, skips Stop and follows the parent's mode", async () => {
    const { runner, calls, events } = hooks();
    const t = subagentHost([task("t1"), chatTool("c1", "write_file", { path: "a.ts", content: "x" }), chatText("Wrote a.ts"), chatText("Done")],
      { extensions: { hooks: runner } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.setMode(sessionId, "accept-edits");
    await agent.prompt(sessionId, text("Write"));
    expect(events()).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PreToolUse", "PostToolUse", "PostToolUse", "Stop"]);
    expect(calls[3][1]).toEqual(expect.objectContaining({ session_id: sessionId, agent_id: expect.any(String), tool_name: "write_file", permission_mode: "acceptEdits" }));
    expect(t.client.at(-1)![1]._meta).toEqual({ oxbit: { mode: "accept-edits" } });
  });

  it("captures one snapshot before parallel task calls run", async () => {
    const log: string[] = [];
    const snapshots: SnapshotStore = { restore: vi.fn(), capture: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push("captured");
      return "snap";
    }) };
    const child: Reply = async function* () {
      log.push("child");
      yield* chatText("Child done");
    };
    const t = subagentHost([chatTools(["t1", "task", { description: "One", prompt: "A" }], ["t2", "task", { description: "Two", prompt: "B" }]), child, child, chatText("Done")],
      { extensions: { snapshots } });
    const agent = new Agent(t.host);
    await agent.prompt(await start(agent), text("Both"));
    expect(snapshots.capture).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["captured", "child", "child"]);
  });

  it("replays the task call with its _meta", async () => {
    const records = new Map<string, SessionRecord>();
    const sessions = { save: async (record: SessionRecord) => void records.set(record.id, structuredClone(record)),
      load: async (id: string) => structuredClone(records.get(id)), list: async () => [] };
    const first = subagentHost([task("t1"), chatText("Found"), chatText("Done")], { extensions: { sessions } });
    const agent = new Agent(first.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("Find"));
    const second = subagentHost([], { extensions: { sessions } });
    await new Agent(second.host).loadSession({ sessionId, cwd: "/root", mcpServers: [] });
    expect(second.sent.map(([, update]) => update)).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "t1",
      _meta: { oxbit: { subagent: expect.objectContaining({ name: "Find the thing", state: "pending" }) } } }));
  });
});
