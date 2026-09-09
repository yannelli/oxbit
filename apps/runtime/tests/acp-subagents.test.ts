import { describe, expect, it } from "vitest";
import { SubagentRegistry } from "../src/acp-subagents.js";
import type { ACPProviderId, ACPSubagent } from "@oxbit/sdk";
function setup(provider: ACPProviderId = "codex") {
  const events: any[] = [];
  const registry = new SubagentRegistry(provider, "root", (event) =>
    events.push(event),
  );
  const spawn = (id: string, parent = "root") =>
    registry.observe(parent, {
      sessionUpdate: "subagent_spawned",
      subagentSessionId: id,
      name: id,
      task: `Task ${id}`,
      capabilities: {},
    });
  const finish = (id: string, state = "completed", parent = "root") =>
    registry.observe(parent, {
      sessionUpdate: "subagent_state_update",
      subagentSessionId: id,
      state,
    });
  const record = (id: string) => registry.records.get(`${provider}:${id}`)!;
  return { registry, spawn, finish, record, events };
}
const collab = (
  tool: string,
  ids: string[],
  states: Record<string, any> = {},
  toolCallId = "dispatch",
) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: tool,
  status: "completed",
  rawInput: { prompt: "Inspect routing", model: "model", agentsStates: states },
  _meta: {
    codex: {
      collaboration: { tool, senderThreadId: "root", receiverThreadIds: ids },
    },
  },
});
describe("dispatched subagent registry", () => {
  it("registers nested sessions once, routes activity and preserves terminal outcomes", () => {
    const { registry, spawn, finish, record } = setup();
    spawn("a");
    spawn("a");
    spawn("b", "a");
    expect(registry.records.size).toBe(2);
    expect(record("b").parentId).toBe("codex:a");
    registry.observe("a", {
      sessionUpdate: "agent_thought_chunk",
      content: { text: "Checking the route" },
    });
    expect(record("a")).toMatchObject({
      state: "running",
      phase: "thinking",
      visibility: "full",
    });
    registry.observe("b", {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { text: "Verified" },
    });
    finish("b", "completed", "a");
    finish("b", "failed", "a");
    spawn("b", "a");
    registry.observe("b", {
      sessionUpdate: "agent_thought_chunk",
      content: { text: "late" },
    });
    expect(record("b")).toMatchObject({
      state: "completed",
      phase: "unknown",
      result: "Verified",
    });
    expect(registry.activeCount).toBe(1);
    expect(registry.acceptsRequest("b")).toBe(false);
  });
  it("rejects foreign sessions, cycles, reparenting and unrelated native events", () => {
    const { registry, spawn, finish } = setup();
    expect(spawn("a", "stranger")).toBe(false);
    expect(registry.acceptsRequest("a")).toBe(false);
    spawn("a");
    spawn("b", "a");
    expect(spawn("root", "b")).toBe(false);
    expect(spawn("a", "b")).toBe(false);
    expect(finish("b", "completed", "root")).toBe(false);
    expect(registry.activeCount).toBe(2);
    const amp = setup("amp");
    expect(amp.spawn("a")).toBe(true); // Generic display event, no native authorization.
    expect(amp.registry.accepts("a")).toBe(false);
  });
  it("buffers bounded early updates without authorizing unknown sessions", () => {
    const { registry, spawn, finish, record } = setup();
    registry.observe("early", {
      sessionUpdate: "agent_message_chunk",
      content: { text: "early result" },
    });
    expect(registry.accepts("early")).toBe(false);
    finish("early", "completed");
    spawn("early");
    expect(record("early")).toMatchObject({
      result: "early result",
      state: "completed",
    });
    expect(registry.activeCount).toBe(0);
  });
  it("keeps reopened generations distinct and reconciles native and fallback identities", () => {
    const { registry, spawn, finish, record } = setup();
    registry.observe(
      "root",
      collab("spawnAgent", ["a"], { a: { status: "running" } }),
    );
    spawn("a");
    expect(registry.records.size).toBe(1);
    expect(record("a").toolCallIds).toEqual(["dispatch"]);
    finish("a");
    spawn("a:generation:2");
    expect(registry.records.size).toBe(2);
    expect(record("a").state).toBe("completed");
    expect(record("a:generation:2").state).toBe("running");
  });
  it("uses structured Codex states, not dispatch completion, and supports fallback reopen", () => {
    const { registry, record } = setup();
    registry.observe("root", collab("spawnAgent", ["a"]));
    expect(record("a").state).toBe("unknown");
    registry.observe(
      "root",
      collab(
        "wait",
        ["a"],
        { a: { status: "completed", message: "Finished" } },
        "wait",
      ),
    );
    expect(record("a")).toMatchObject({
      state: "completed",
      result: "Finished",
      visibility: "limited",
    });
    registry.observe(
      "root",
      collab("resumeAgent", ["a"], { a: { status: "running" } }, "resume"),
    );
    registry.observe(
      "root",
      collab("resumeAgent", ["a"], { a: { status: "running" } }, "resume"),
    );
    expect(registry.records.size).toBe(2);
    expect(registry.activeCount).toBe(1);
    registry.disconnect();
    expect(registry.activeCount).toBe(0);
  });
  it("replaces provisional dispatches with reported identities and keeps dispatch failures", () => {
    const { registry, events } = setup();
    registry.observe("root", collab("spawnAgent", []));
    const order = [...registry.records.values()][0].order;
    registry.observe(
      "root",
      collab("spawnAgent", ["a"], { a: { status: "pendingInit" } }),
    );
    expect(registry.records.size).toBe(1);
    expect(events.at(-1).removedIds).toContain('tool:["root","dispatch"]');
    expect(registry.records.get("codex:a")?.order).toBe(order);
    registry.observe("root", {
      ...collab("spawnAgent", [], {}, "bad"),
      status: "failed",
    });
    expect(registry.records.get('tool:["root","bad"]')?.state).toBe("failed");
  });
  it("correlates Cursor metadata with earlier tools and explicit outcomes", () => {
    const { registry } = setup("cursor");
    registry.observe("root", {
      sessionUpdate: "tool_call_update",
      toolCallId: "task",
      status: "completed",
      rawOutput: { result: "A result" },
    });
    registry.observe("root", {
      sessionUpdate: "cursor/task",
      toolCallId: "task",
      description: "Inspect",
      prompt: "Inspect routing",
      durationMs: 50,
    });
    const first = registry.records.get('tool:["root","task"]')!;
    expect(first).toMatchObject({
      state: "unknown",
      visibility: "limited",
      result: "A result",
      durationMs: 50,
    });
    registry.observe("root", {
      sessionUpdate: "cursor/task",
      toolCallId: "task",
      agentId: "cursor-child",
      outcome: { outcome: "completed" },
    });
    expect(registry.records.size).toBe(1);
    expect(registry.records.get("cursor:cursor-child")).toMatchObject({
      state: "completed",
      name: "Inspect",
    });
  });
  it("tracks Amp tasks conservatively and ignores arbitrary tools and prose", () => {
    const { registry } = setup("amp");
    registry.observe("root", {
      sessionUpdate: "tool_call",
      toolCallId: "task",
      title: "Task: Find route",
      kind: "think",
      rawInput: { prompt: "Find route", description: "Find route" },
      status: "pending",
    });
    registry.observe("root", {
      sessionUpdate: "tool_call_update",
      toolCallId: "task",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Found route" } },
      ],
    });
    registry.observe("root", {
      sessionUpdate: "tool_call",
      toolCallId: "other",
      title: "Task",
      kind: "execute",
      rawInput: { description: "not delegation" },
    });
    registry.observe("root", {
      sessionUpdate: "agent_message_chunk",
      content: { text: "I spawned an agent" },
    });
    expect(registry.records.size).toBe(1);
    expect(registry.records.get('tool:["root","task"]')).toMatchObject({
      state: "unknown",
      evidence: "tool",
    });
    expect(registry.activeCount).toBe(0);
  });
  it("tracks multiple waiting requests, terminal activity and historical replay", () => {
    const { registry, spawn, record } = setup();
    registry.replaying = true;
    spawn("a");
    expect(registry.activeCount).toBe(0);
    expect(record("a").historical).toBe(true);
    registry.replaying = false;
    registry.waiting("a", "one", true);
    registry.waiting("a", "two", true);
    registry.waiting("a", "one", false);
    expect(record("a").phase).toBe("awaiting_input");
    registry.terminal("a", "term", "echo", "text", false);
    expect(record("a").phase).toBe("awaiting_input");
    registry.waiting("a", "two", false);
    expect(record("a").phase).toBe("unknown");
    expect(registry.activeCount).toBe(1);
  });
  it("bounds previews while retaining authorization for pruned sessions", () => {
    const { registry, spawn, record, events } = setup();
    for (let i = 0; i < 260; i++) spawn(`child-${i}`);
    expect(registry.records.size).toBe(256);
    expect(registry.acceptsRequest("child-0")).toBe(true);
    expect(registry.activeCount).toBe(260);
    expect(registry.truncated).toBe(true);
    for (let i = 0; i < 50; i++)
      registry.observe("child-0", {
        sessionUpdate: "agent_message_chunk",
        messageId: `m-${i}`,
        content: { text: "x".repeat(20000) },
      });
    expect(record("child-0").activity.length).toBeLessThanOrEqual(32);
    expect(record("child-0").truncated).toBe(true);
    expect(events.at(-1).activeCount).toBe(260);
    const bytes = [...registry.records.values()].reduce(
      (sum, child: ACPSubagent) => sum + JSON.stringify(child.activity).length,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(512000);
  });
  it("does not rewind finished tools or confuse session/tool identifiers", () => {
    const { registry, spawn, record } = setup();
    spawn("a");
    spawn("a:b");
    registry.observe("a", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
    });
    registry.observe("a", {
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: "Late start",
      status: "pending",
    });
    expect(record("a").phase).toBe("unknown");
    registry.observe("a", {
      sessionUpdate: "tool_call",
      toolCallId: "b:task",
      ...collab("spawnAgent", ["first"], {}, "b:task"),
    });
    registry.observe("a:b", {
      sessionUpdate: "tool_call_update",
      toolCallId: "task",
      status: "failed",
    });
    expect(registry.records.has("codex:first")).toBe(true);
    expect(registry.idForTool("a:b", "task")).toBeUndefined();
  });
  it("ignores malformed provider fields and attributes limited-task approvals", () => {
    const { registry, record } = setup();
    registry.observe("root", {
      ...collab("spawnAgent", ["a"], { a: { status: "constructor" } }),
      _meta: {
        codex: {
          subagent: { threadId: "a", path: 123, activity: "constructor" },
        },
      },
    });
    expect(record("a").state).toBe("unknown");
    const cursor = setup("cursor").registry;
    cursor.observe("root", {
      sessionUpdate: "cursor/task",
      toolCallId: "task",
      description: "Inspect",
    });
    cursor.waiting("root", "approval", true, "task");
    expect([...cursor.records.values()][0].phase).toBe("awaiting_input");
    cursor.waiting("root", "approval", false, "task");
    expect([...cursor.records.values()][0].phase).toBe("unknown");
  });
  it("retains fallback lifecycle state after display pruning", () => {
    const { registry } = setup();
    for (let i = 0; i < 260; i++)
      registry.observe(
        "root",
        collab(
          "spawnAgent",
          [`child-${i}`],
          { [`child-${i}`]: { status: "running" } },
          `dispatch-${i}`,
        ),
      );
    expect(registry.records.size).toBe(256);
    expect(registry.activeCount).toBe(260);
    registry.observe(
      "root",
      collab(
        "wait",
        ["child-0"],
        { "child-0": { status: "completed" } },
        "wait",
      ),
    );
    registry.observe(
      "root",
      collab(
        "spawnAgent",
        ["child-0"],
        { "child-0": { status: "running" } },
        "dispatch-0",
      ),
    );
    expect(registry.records.get("codex:child-0")?.state).toBe("completed");
    expect(registry.activeCount).toBe(259);
  });
});
