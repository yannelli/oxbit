import { describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import { CLEARED_OUTPUT, COMPACT_FOCUS, Compaction, keepFrom, pruneToolOutputs, summaryNote } from "./compaction.js";
import type { SessionView } from "./extensions.js";
import type { Turn } from "./model.js";
import { chatText, sse } from "./test-models.js";
import { hooks, start, testHost, text } from "./test-host.js";

const user = (value: string): Turn => ({ role: "user", text: value });
const reply = (value: string): Turn => ({ role: "assistant", text: value, calls: [] });
const call = (id: string, name = "read_file"): Turn => ({ role: "assistant", text: "", calls: [{ id, name, arguments: "{}" }] });
const result = (id: string, output: string, name = "read_file"): Turn => ({ role: "tool", results: [{ id, name, output }] });
const tokens = (count: number) => "x".repeat(count * 4);
const session = (turns: Turn[], meta: Record<string, unknown> = {}): SessionView => ({ id: "s", cwd: "/root", model: "m", turns, meta });
const outputs = (turns: Turn[]) => turns.flatMap((turn) => turn.role === "tool" ? turn.results.map((item) => item.output.slice(0, 40)) : []);

describe("shouldCompact", () => {
  it("is due when input plus output reaches the window minus min(reserve, max output, window / 4)", () => {
    const compaction = new Compaction();
    expect(compaction.shouldCompact(session([]), { input: 179000, output: 1000 }, 200000)).toBe(true);
    expect(compaction.shouldCompact(session([]), { input: 179000, output: 999 }, 200000)).toBe(false);
    expect(compaction.shouldCompact(session([]), { input: 185000, output: 0 }, 200000, 8000)).toBe(false);
    expect(compaction.threshold(16000)).toBe(12000);
    expect(compaction.shouldCompact(session([]), { input: 1e9, output: 0 })).toBe(false);
    expect(new Compaction({ auto: false }).shouldCompact(session([]), { input: 1e9, output: 0 }, 200000)).toBe(false);
  });
});

describe("Compaction percent", () => {
  it("compacts at a percent of the window from 50 to 95 and keeps the reserve rule otherwise", () => {
    const options = { percent: 80 as number | undefined };
    const compaction = new Compaction(options);
    expect(compaction.threshold(200000)).toBe(160000);
    expect(compaction.shouldCompact(session([]), { input: 160000, output: 0 }, 200000)).toBe(true);
    expect(compaction.shouldCompact(session([]), { input: 159999, output: 0 }, 200000)).toBe(false);
    options.percent = 99;
    expect(compaction.threshold(200000)).toBe(180000);
    options.percent = undefined;
    expect(compaction.threshold(16000)).toBe(12000);
  });
});

describe("pruneToolOutputs", () => {
  it("clears outputs past the newest 40k tokens before the last two user turns and keeps skill outputs", () => {
    const turns = [user("a"), call("1"), result("1", tokens(30000)), call("2"), result("2", tokens(30000)), call("3", "skill"),
      result("3", tokens(50000), "skill"), user("b"), reply("ok"), user("c"), call("4"), result("4", tokens(50000))];
    const pruned = pruneToolOutputs(turns);
    expect(pruned.saved).toBe(30000);
    expect(outputs(pruned.turns)).toEqual([CLEARED_OUTPUT, ...outputs(turns).slice(1)]);
    expect(outputs(turns)[0]).toBe(tokens(10));
  });
  it("changes nothing when it would save under 20k tokens or there are fewer than two user turns", () => {
    const small = [user("a"), call("1"), result("1", tokens(10000)), call("2"), result("2", tokens(35000)), user("b"), user("c")];
    expect(pruneToolOutputs(small)).toEqual({ turns: small, saved: 0 });
    const single = [user("a"), call("1"), result("1", tokens(90000)), call("2"), result("2", tokens(90000))];
    expect(pruneToolOutputs(single).saved).toBe(0);
  });
});

describe("Compaction.compact", () => {
  it("keeps the newest turns within the budget without starting at a tool result", () => {
    const turns = [user("go"), call("1"), result("1", tokens(15000)), call("2"), result("2", tokens(10000)), reply("done")];
    expect(keepFrom(turns, 20000)).toBe(3);
    expect(keepFrom([user("go"), call("1"), result("1", tokens(30000))], 20000)).toBe(3);
  });
  it("summarizes the dropped turns with the focus and returns the note plus the kept turns", async () => {
    const turns = [user(tokens(30000)), call("1"), result("1", "file text"), reply("Read it")];
    const summarize = vi.fn(async () => " Summary ");
    const compacted = await new Compaction().compact(session(turns, { [COMPACT_FOCUS]: "the tests" }), summarize, new AbortController().signal);
    expect(compacted).toEqual([user(summaryNote("Summary")), ...turns.slice(1)]);
    const [system, request] = summarize.mock.calls[0] as unknown as [string, Turn[]];
    expect(system).toContain("context summarization assistant");
    expect(request).toHaveLength(1);
    const prompt = (request[0] as { text: string }).text;
    expect(prompt).toMatch(/^<conversation>\n\[User\]\nx+\n<\/conversation>/);
    for (const section of ["## Goal", "## Decisions", "## Files touched", "## Open work", "## User preferences"]) expect(prompt).toContain(section);
    expect(prompt.endsWith("Additional focus: the tests")).toBe(true);
  });
  it("summarizes every turn when all of them fit in the kept budget", async () => {
    const summarize = vi.fn(async () => "S");
    const turns = [user("hi"), call("1"), result("1", "out"), reply("ok")];
    expect(await new Compaction().compact(session(turns), summarize, new AbortController().signal)).toEqual([user(summaryNote("S"))]);
    expect((summarize.mock.calls[0] as unknown as [string, Turn[]])[1][0]).toEqual(expect.objectContaining({
      text: expect.stringContaining("[User]\nhi\n\n[Tool call read_file]\n{}\n\n[Tool result read_file]\nout\n\n[Assistant]\nok") }));
  });
  it("returns pruned turns without a summary when pruning brings an auto compaction under the threshold", async () => {
    const compaction = new Compaction();
    const turns = [user("a"), call("1"), result("1", tokens(50000)), call("2"), result("2", tokens(50000)), user("b"), reply("ok"), user("c")];
    const view = session(turns);
    expect(compaction.shouldCompact(view, { input: 185000, output: 0 }, 200000)).toBe(true);
    const summarize = vi.fn(async () => "S");
    const compacted = await compaction.compact(view, summarize, new AbortController().signal);
    expect(summarize).not.toHaveBeenCalled();
    expect(outputs(compacted)).toEqual([CLEARED_OUTPUT, CLEARED_OUTPUT]);
    expect(compacted.slice(5)).toEqual(turns.slice(5));
  });
  it("rejects an empty summary", async () => {
    await expect(new Compaction().compact(session([user("hi")]), async () => " ", new AbortController().signal)).rejects.toThrow("empty summary");
  });
});

describe("Agent compaction", () => {
  it("runs /compact with its focus, reports the result, and continues from the summary", async () => {
    const compaction = new Compaction();
    const { runner, calls } = hooks();
    const t = testHost([chatText("Hello"), chatText("The summary"), chatText("Next")], { extensions: { compactor: compaction, commands: [compaction], hooks: runner } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("hi"));
    expect(await agent.prompt(sessionId, text("/compact keep the tests"))).toEqual({ stopReason: "end_turn" });
    expect(t.messages(1).at(-1)!.content).toMatch(/\[User\]\nhi\n\n\[Assistant\]\nHello\n<\/conversation>[\s\S]*Additional focus: keep the tests$/);
    expect(t.updates).toContainEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Compacted 2 turns into a summary and 0 recent turns." } });
    expect(calls.find(([event]) => event === "PreCompact")![1]).toEqual(expect.objectContaining({ trigger: "manual" }));
    await agent.prompt(sessionId, text("go on"));
    expect(t.messages().slice(1)).toEqual([{ role: "user", content: summaryNote("The summary") }, { role: "user", content: "go on" }]);
    expect((agent as any).sessions.get(sessionId).meta).not.toHaveProperty(COMPACT_FOCUS);
  });
  it("compacts automatically when usage reaches the threshold of the model's context window", async () => {
    const full = sse({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 760, completion_tokens: 2 } });
    const compaction = new Compaction();
    const t = testHost([full, chatText("Auto summary"), chatText("Next")], { extensions: { compactor: compaction } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("hi"));
    await agent.prompt(sessionId, text("go on"));
    expect(t.messages().slice(1)).toEqual([{ role: "user", content: summaryNote("Auto summary") }, { role: "user", content: "go on" }]);
  });
});
