import { describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import type { Compactor, ContinuationProvider, SnapshotStore } from "./extensions.js";
import { chatText, chatTool, chatTools } from "./test-models.js";
import { hooks, start, testHost, text } from "./test-host.js";

describe("Agent hooks", () => {
  it("passes Claude Code hook fields and denies a tool from PreToolUse without running it", async () => {
    const { runner, calls, events } = hooks((event) => event === "PreToolUse" ? { permission: "deny", permissionReason: "No reads" } : undefined);
    const t = testHost([chatTool("call_1", "read_file", { path: "a.ts" }), chatText("Ok")], { extensions: { hooks: runner } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    expect(await agent.prompt(sessionId, text("Read"))).toEqual({ stopReason: "end_turn" });
    expect(t.client).toEqual([]);
    expect(t.messages().at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "No reads" });
    expect(events()).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"]);
    expect(calls[2][1]).toEqual({ session_id: sessionId, cwd: "/root", hook_event_name: "PreToolUse", permission_mode: "default", tool_name: "read_file",
      tool_input: { path: "a.ts" }, tool_use_id: "call_1" });
    expect(t.updates.filter((update) => update.sessionUpdate === "tool_call_update").map((update) => update.status)).toEqual(["failed"]);
  });
  it("asks through session/request_permission and runs the tool only when allowed", async () => {
    const answers = ["reject", "allow"];
    const { runner } = hooks((event) => event === "PreToolUse" ? { permission: "ask", permissionReason: "Writes need approval" } : undefined);
    const t = testHost([chatTool("call_1", "write_file", { path: "a.ts", content: "x" }), chatTool("call_2", "write_file", { path: "a.ts", content: "y" }), chatText("Ok")], {
      extensions: { hooks: runner },
      respond: (method) => method === "session/request_permission" ? { outcome: { outcome: "selected", optionId: answers.shift() } } : undefined,
    });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("Write"));
    const asks = t.client.filter(([method]) => method === "session/request_permission").map(([, params]) => params);
    expect(asks[0]).toEqual({ sessionId, toolCall: { toolCallId: "call_1", title: "Write a.ts", kind: "edit", status: "pending", rawInput: { path: "a.ts", content: "x" } },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] });
    expect(t.messages(1).at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "The user denied this tool call: Writes need approval" });
    expect(t.files).toEqual({ "/root/a.ts": "y" });
  });
  it("replaces tool arguments with updatedInput and appends PostToolUse context", async () => {
    const { runner, calls } = hooks((event) => event === "PreToolUse" ? { updatedInput: { path: "b.ts" } }
      : event === "PostToolUse" ? { additionalContext: "Checked by a hook" } : undefined);
    const t = testHost([chatTool("call_1", "read_file", { path: "a.ts" }), chatText("Ok")], { extensions: { hooks: runner }, files: { "/root/b.ts": "B" } });
    const agent = new Agent(t.host);
    await agent.prompt(await start(agent), text("Read"));
    expect(t.client.map(([method, params]) => [method, params.path])).toEqual([["fs/read_text_file", "/root/b.ts"]]);
    expect(t.messages().at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "B\n\nChecked by a hook" });
    expect(calls.find(([event]) => event === "PostToolUse")![1]).toEqual(expect.objectContaining({ tool_input: { path: "b.ts" }, tool_response: "B" }));
    expect(t.updates).toContainEqual({ sessionUpdate: "tool_call_update", toolCallId: "call_1", title: "Read b.ts", rawInput: { path: "b.ts" } });
  });
  it("reports a failed tool to PostToolUseFailure", async () => {
    const { runner, calls } = hooks();
    const t = testHost([chatTool("call_1", "edit_file", { path: "a.ts", old_string: "x", new_string: "y" }), chatText("Ok")], { extensions: { hooks: runner } });
    const agent = new Agent(t.host);
    await agent.prompt(await start(agent), text("Edit"));
    expect(calls.find(([event]) => event === "PostToolUseFailure")![1]).toEqual(expect.objectContaining({ tool_name: "edit_file",
      error: expect.stringContaining("old_string was not found") }));
  });
  it("blocks a prompt from UserPromptSubmit and appends its context", async () => {
    const outcomes = [{ block: true, reason: "No secrets" }, { additionalContext: "Today is Monday" }];
    const { runner } = hooks((event) => event === "UserPromptSubmit" ? outcomes.shift() : undefined);
    const t = testHost([chatText("Ok")], { extensions: { hooks: runner } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await expect(agent.prompt(sessionId, text("Key?"))).rejects.toThrow("No secrets");
    expect(t.posts()).toEqual([]);
    await agent.prompt(sessionId, text("Day?"));
    expect(t.messages().slice(1)).toEqual([{ role: "user", content: "Day?\n\nToday is Monday" }]);
  });
  it("continues after a blocking Stop hook with stop_hook_active on the next Stop", async () => {
    const outcomes = [{ block: true, reason: "Run the tests" }];
    const { runner, calls } = hooks((event) => event === "Stop" ? outcomes.shift() : undefined);
    const t = testHost([chatText("Done"), chatText("Tests pass")], { extensions: { hooks: runner } });
    const agent = new Agent(t.host);
    expect(await agent.prompt(await start(agent), text("Fix"))).toEqual({ stopReason: "end_turn" });
    expect(t.posts()).toHaveLength(2);
    expect(t.messages().at(-1)).toEqual({ role: "user", content: "Run the tests" });
    expect(calls.filter(([event]) => event === "Stop").map(([, input]) => [input.stop_hook_active, input.last_assistant_message]))
      .toEqual([[false, "Done"], [true, "Tests pass"]]);
    expect(t.updates).toContainEqual({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Run the tests" } });
  });
  it("stops the turn when a hook returns continue: false and skips the remaining tools", async () => {
    const { runner } = hooks((event) => event === "PreToolUse" ? { continue: false, stopReason: "Budget reached" } : undefined);
    const t = testHost([chatTools(["call_1", "list_files", {}], ["call_2", "list_files", {}])], { extensions: { hooks: runner } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    expect(await agent.prompt(sessionId, text("Go"))).toEqual({ stopReason: "end_turn" });
    expect(t.posts()).toHaveLength(1);
    expect(t.updates.filter((update) => update.sessionUpdate === "tool_call").map((update) => update.toolCallId)).toEqual(["call_1"]);
    expect(t.updates.at(-1)).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nBudget reached\n\n" } });
  });
  it("runs continuation providers after Stop until they return nothing", async () => {
    const next = vi.fn<ContinuationProvider["next"]>().mockResolvedValueOnce("Keep going").mockResolvedValue(undefined);
    const t = testHost([chatText("A"), chatText("B")], { extensions: { continuations: [{ next }] } });
    const agent = new Agent(t.host);
    await agent.prompt(await start(agent), text("Start"));
    expect(next).toHaveBeenCalledTimes(2);
    expect(t.messages().slice(-2)).toEqual([{ role: "assistant", content: "A" }, { role: "user", content: "Keep going" }]);
  });
  it("gives each continuation a full step budget", async () => {
    let left = 70;
    const t = testHost(Array.from({ length: 71 }, () => chatText("Again")), { extensions: { continuations: [{ next: async () => left-- > 0 ? "Continue" : undefined }] } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    expect(await agent.prompt(sessionId, text("Go"))).toEqual({ stopReason: "end_turn" });
    expect(left).toBe(-1);
  });
  it("compacts after a finished step with PreCompact and PostCompact around it", async () => {
    const { runner, events } = hooks();
    const compactor: Compactor = {
      shouldCompact: vi.fn(() => true),
      compact: vi.fn(async (_session, summarize) => [{ role: "user" as const, text: `Summary: ${await summarize("Summarize", [{ role: "user", text: "all" }])}` }]),
    };
    const t = testHost([chatText("Answer"), chatText("The summary"), chatText("Next")], { extensions: { hooks: runner, compactor } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("Ask"));
    expect(compactor.shouldCompact).toHaveBeenCalledWith(expect.objectContaining({ id: sessionId }), { input: 10, output: 2 }, 1000, undefined);
    expect(t.messages(1)).toEqual([{ role: "system", content: "Summarize" }, { role: "user", content: "all" }]);
    expect(events()).toEqual(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop"]);
    expect(t.updates.some((update) => update.content?.text?.includes("Compacted the conversation"))).toBe(true);
    vi.mocked(compactor.shouldCompact).mockReturnValue(false);
    await agent.prompt(sessionId, text("Again"));
    expect(t.messages().slice(1)).toEqual([{ role: "user", content: "Summary: The summary" }, { role: "user", content: "Again" }]);
  });
  it("captures one snapshot per step before the first mutating tool", async () => {
    const snapshots: SnapshotStore = { capture: vi.fn(async (label: string) => `snap-${label}`), restore: vi.fn() };
    const saved: Record<string, unknown>[] = [];
    const t = testHost([
      chatTools(["call_1", "read_file", { path: "a.ts" }], ["call_2", "write_file", { path: "a.ts", content: "1" }], ["call_3", "write_file", { path: "b.ts", content: "2" }]),
      chatTool("call_4", "edit_file", { path: "a.ts", old_string: "1", new_string: "3" }),
      chatText("Done"),
    ], { extensions: { snapshots, sessions: { save: async (record) => void saved.push(record.meta), load: async () => undefined, list: async () => [] } } });
    const agent = new Agent(t.host);
    await agent.prompt(await start(agent), text("Write"));
    expect(vi.mocked(snapshots.capture).mock.calls).toEqual([["Write a.ts", "/root"], ["Edit a.ts", "/root"]]);
    expect(saved.at(-1)!.snapshots).toEqual([{ id: "snap-Write a.ts", label: "Write a.ts", turn: 2 }, { id: "snap-Edit a.ts", label: "Edit a.ts", turn: 4 }]);
  });
});
