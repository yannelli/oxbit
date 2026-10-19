import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { Compaction } from "./compaction.js";
import { contextGrid, type ContextUsage } from "./context-usage.js";
import { replay } from "./session-records.js";
import type { AgentExtensions, AgentTool, Params } from "./extensions.js";
import type { ModelInfo } from "./model.js";
import { chatText } from "./test-models.js";
import { start, testHost, text } from "./test-host.js";

const mcp: AgentTool = { spec: { name: "mcp__docs__search", description: "Search the docs", parameters: { type: "object", properties: {} } },
  kind: "search", title: () => "Search", run: async () => "" };
const extensions = (compactor = new Compaction()): AgentExtensions => ({
  context: [
    { label: "Instructions", system: async () => "i".repeat(400) },
    { label: "Skills", system: async () => "s".repeat(40) },
    { system: async () => "o".repeat(80) },
  ],
  tools: [{ tools: () => [mcp] }],
  compactor,
});

async function run(catalog: ModelInfo[], extra: AgentExtensions = extensions(), replies = [chatText("hello")]) {
  const harness = testHost(replies, { extensions: extra, host: { catalog: () => catalog, model: () => "m" } });
  const agent = new Agent(harness.host);
  const sessionId = await start(agent);
  const context = async () => {
    harness.updates.length = 0;
    expect(await agent.prompt(sessionId, text("/context"))).toEqual({ stopReason: "end_turn" });
    const chunk = harness.updates.find((update) => update._meta?.oxbit?.context)!;
    return { usage: chunk._meta.oxbit.context as ContextUsage, text: chunk.content.text as string };
  };
  return { ...harness, agent, sessionId, context };
}
const tokensOf = (usage: ContextUsage) => Object.fromEntries(usage.categories.map((category) => [category.id, category.tokens]));
const gridRows = (text: string) => text.split("\n").filter((line) => /^\S( \S){19}$/.test(line));

describe("/context", () => {
  it("estimates each category and reads the threshold from the compactor", async () => {
    const harness = await run([{ id: "m", name: "M", contextWindow: 200000, maxOutput: 8000 }]);
    await harness.agent.prompt(harness.sessionId, text("hi"));
    const { usage, text: reply } = await harness.context();
    const tokens = tokensOf(usage);
    expect(usage.categories.map((category) => category.id)).toEqual(["system", "instructions", "skills", "context", "tools", "mcp", "messages"]);
    expect(tokens).toMatchObject({ instructions: 100, skills: 10, context: 20, mcp: Math.ceil(JSON.stringify(mcp.spec).length / 4), messages: 2 });
    expect(tokens.system).toBeGreaterThan(0);
    expect(tokens.tools).toBeGreaterThan(0);
    expect(usage.used).toBe(Object.values(tokens).reduce((sum, value) => sum + value, 0));
    expect(usage).toMatchObject({ model: "m", estimated: true, window: 200000, maxOutput: 8000, threshold: new Compaction().threshold(200000, 8000),
      free: 192000 - usage.used, buffer: 8000, reported: { input: 10, output: 2 } });
    expect(reply).toContain("```text");
    expect(gridRows(reply)).toHaveLength(10);
    expect(reply).toMatch(/x Auto-compact buffer +8k +4\.0%/);
    expect(reply).toContain("Auto compaction runs at 192k tokens (96.0%).");
    expect(harness.updates.some((update) => update.sessionUpdate === "agent_message_chunk" && !update._meta)).toBe(false);
  });

  it("lists the command and reports no threshold when auto compaction is off", async () => {
    const harness = await run([{ id: "m", name: "M", contextWindow: 16000 }], extensions(new Compaction({ auto: false })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const commands = harness.updates.find((update) => update.sessionUpdate === "available_commands_update")!.availableCommands as Params[];
    expect(commands[0]).toMatchObject({ name: "context", description: "Show context window usage" });
    const { usage, text: reply } = await harness.context();
    expect(usage.threshold).toBeUndefined();
    expect(usage.buffer).toBeUndefined();
    expect(usage.free).toBe(16000 - usage.used);
    expect(reply).toContain("Auto compaction is off.");
    expect(reply).not.toContain("Auto-compact buffer");
  });

  it("lists estimates without a grid when the window is unknown", async () => {
    const { usage, text: reply } = await (await run([{ id: "m", name: "M" }])).context();
    expect(usage.window).toBeUndefined();
    expect(usage.threshold).toBeUndefined();
    expect(usage.free).toBeUndefined();
    expect(usage.categories).toHaveLength(7);
    expect(reply).toContain("The context window of this model is unknown.");
    expect(gridRows(reply)).toHaveLength(0);
    expect(reply).toMatch(/= Instructions +100\n/);
  });
});

describe("contextGrid", () => {
  const usage = (tokens: number[], window: number, threshold?: number): ContextUsage => ({ model: "m", estimated: true, window, threshold,
    categories: tokens.map((count, index) => ({ id: `c${index}`, label: `C${index}`, tokens: count })), used: tokens.reduce((sum, count) => sum + count, 0) });

  it("gives a non-empty category one cell, then free cells and buffer cells from the threshold", () => {
    const cells = (id: string, count: number) => Array<string>(count).fill(id);
    expect(contextGrid(usage([1, 0, 50], 100, 90), 20)).toEqual([...cells("c0", 1), ...cells("c2", 9), ...cells("free", 8), ...cells("buffer", 2)]);
  });
  it("scales categories to the grid when the estimate exceeds the window", () => {
    expect(contextGrid(usage([300, 100], 200, 150), 4)).toEqual(["c0", "c0", "c0", "c1"]);
  });
});

describe("context usage note", () => {
  it("tells the model the last request's size on the next prompt and hides it from replays", async () => {
    const harness = await run([{ id: "m", name: "M", contextWindow: 200000, maxOutput: 8000 }], extensions(), [chatText("one"), chatText("two")]);
    await harness.agent.prompt(harness.sessionId, text("first"));
    expect(harness.messages().at(-1)).toEqual({ role: "user", content: "first" });
    await harness.agent.prompt(harness.sessionId, text("second"));
    expect(harness.messages().at(-1)!.content).toBe("second\n\n<context-usage>The last request used 12 of 200,000 context tokens (0%). "
      + `Auto compaction runs at ${new Compaction().threshold(200000, 8000).toLocaleString("en-US")} tokens.</context-usage>`);
    const replayed: Params[] = [];
    replay([{ role: "user", text: harness.messages().at(-1)!.content as string }], [], (update) => replayed.push(update));
    expect(replayed[0].content.text).toBe("second");
  });

  it("adds nothing when the window is unknown", async () => {
    const harness = await run([{ id: "m", name: "M" }], extensions(), [chatText("one"), chatText("two")]);
    await harness.agent.prompt(harness.sessionId, text("first"));
    await harness.agent.prompt(harness.sessionId, text("second"));
    expect(harness.messages().at(-1)).toEqual({ role: "user", content: "second" });
  });
});
