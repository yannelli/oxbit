import { describe, expect, test } from "vitest";
import type { SessionUpdate } from "./connection.js";
import { applyStatus, emptyStatus } from "./status.js";
import { append, applyUpdate, emptyTranscript, endTurn, type Transcript } from "./transcript.js";

const text = (sessionUpdate: string, value: string): SessionUpdate => ({ sessionUpdate, content: { type: "text", text: value } });
const apply = (state: Transcript, ...updates: SessionUpdate[]) => updates.reduce(applyUpdate, state);
const types = (items: { type: string }[]) => items.map((item) => item.type);

describe("transcript", () => {
  test("keeps streaming items live and flushes them in order", () => {
    let state = append(emptyTranscript(), { type: "user", text: "hi" });
    state = apply(state, text("agent_thought_chunk", "think"), text("agent_message_chunk", "Hel"), text("agent_message_chunk", "lo"));
    expect(types(state.flushed)).toEqual(["banner", "user", "thought"]);
    expect(state.live).toMatchObject([{ type: "assistant", text: "Hello" }]);
    state = apply(state, { sessionUpdate: "tool_call", toolCallId: "t", title: "Read a", kind: "read", status: "in_progress" });
    expect(types(state.flushed)).toEqual(["banner", "user", "thought", "assistant"]);
    expect(state.live).toMatchObject([{ type: "tool", tool: { status: "in_progress" } }]);
    state = apply(state, { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", rawOutput: "body" });
    expect(state.live).toEqual([]);
    expect(state.flushed.at(-1)).toMatchObject({ type: "tool", tool: { title: "Read a", kind: "read", status: "completed", output: "body" } });
    state = apply(state, { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" });
    expect(state.flushed.filter((item) => item.type === "tool")).toHaveLength(1);
  });

  test("moves finished paragraphs of a long message to scrollback while it streams", () => {
    const state = apply(emptyTranscript(), text("agent_message_chunk", "First paragraph.\n\n```ts\nopen\n\nstill code"));
    expect(state.flushed.at(-1)).toMatchObject({ type: "assistant", text: "First paragraph.\n\n", done: true });
    expect(state.live).toMatchObject([{ type: "assistant", text: "```ts\nopen\n\nstill code", part: true }]);
  });

  test("keeps diffs across updates and marks unfinished tools cancelled at the end of a turn", () => {
    let state = apply(emptyTranscript(),
      { sessionUpdate: "tool_call", toolCallId: "e", title: "Edit a", kind: "edit", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "e", content: [{ type: "diff", path: "/w/a", oldText: "x", newText: "y" }] },
      { sessionUpdate: "plan", entries: [{ content: "step", status: "pending" }] },
      { sessionUpdate: "plan", entries: [{ content: "step", status: "completed" }] });
    expect(state.live).toMatchObject([{ type: "tool", tool: { diffs: [{ path: "/w/a", oldText: "x", newText: "y" }] } }, { type: "plan", entries: [{ status: "completed" }] }]);
    state = endTurn(state);
    expect(state.live).toEqual([]);
    expect(state.flushed.slice(-2)).toMatchObject([{ type: "tool", tool: { status: "cancelled" } }, { type: "plan" }]);
  });

  test("reads status fields from updates", () => {
    let status = emptyStatus();
    for (const update of [
      { sessionUpdate: "available_commands_update", availableCommands: [{ name: "goal", description: "Set a goal", input: { hint: "<objective>" } }] },
      { sessionUpdate: "current_mode_update", currentModeId: "full-auto" },
      { sessionUpdate: "session_info_update", title: "Title", _meta: { oxbit: { goal: { status: "active", objective: "x" } } } },
      { sessionUpdate: "usage_update", used: 50, size: 200 },
    ]) status = applyStatus(status, update);
    expect(status).toMatchObject({ mode: "full-auto", title: "Title", usage: { used: 50, size: 200 }, goal: { status: "active" },
      commands: [{ name: "goal", description: "Set a goal", hint: "<objective>" }] });
    expect(applyStatus(status, { sessionUpdate: "session_info_update", _meta: { oxbit: { goal: null } } }).goal).toBeUndefined();
  });
});
