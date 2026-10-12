import type { ContextUsage } from "@oxbit/agent-core";
import { describe, expect, test } from "vitest";
import { FakeConnection } from "./fake-connection.js";
import { run } from "./index.js";
import { KEYS, terminal, waitFor } from "./test-terminal.js";

const USAGE: ContextUsage = { model: "gpt-5.1", estimated: true, used: 53510, window: 272000, threshold: 252000, free: 198490, buffer: 20000,
  reported: { input: 51000, output: 812 }, categories: [
    { id: "system", label: "System prompt", tokens: 120 }, { id: "instructions", label: "Instructions", tokens: 3400 },
    { id: "skills", label: "Skills", tokens: 890 }, { id: "context", label: "Other context", tokens: 0 },
    { id: "tools", label: "Built-in tools", tokens: 2100 }, { id: "mcp", label: "MCP and extension tools", tokens: 5000 },
    { id: "messages", label: "Messages", tokens: 42000 },
  ] };

async function show(usage: ContextUsage, columns: number) {
  const term = terminal(columns, 40);
  const connection = new FakeConnection([async (context) => {
    context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "```text\nplain grid\n```" }, _meta: { oxbit: { context: usage } } });
  }]);
  const done = run(connection, { cwd: "/work/project", debug: true, ...term.streams });
  const frame = () => term.stdout.frame();
  await waitFor(() => frame().includes("Ask anything"), frame);
  term.stdin.press(..."context", KEYS.enter);
  await waitFor(() => frame().includes("Category counts are estimates"), frame);
  const shown = frame();
  term.stdin.press(KEYS.ctrlC, KEYS.ctrlC);
  await done;
  return shown;
}

describe("context view", () => {
  test("renders the grid beside the legend in place of the text reply", async () => {
    const frame = await show(USAGE, 100);
    expect(frame).toContain("Context usage for gpt-5.1: 53.5k of 272k tokens (19.7%).");
    expect(frame).not.toContain("plain grid");
    expect(frame).toMatch(/■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ +■ System prompt +120 +0\.0%/);
    expect(frame).toMatch(/□ □ □ □ □ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠/);
    expect(frame).toMatch(/⊠ Auto-compact buffer +20k +7\.4%/);
    expect(frame).toContain("Auto compaction runs at 252k tokens (92.6%).");
  });

  test("puts the legend under the grid when narrow and skips the grid without a window", async () => {
    expect(await show(USAGE, 60)).toMatch(/□ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠\n\s*\n\s*■ System prompt/);
    const unknown = await show({ model: "qwen3:0.6b", estimated: true, used: 600, categories: USAGE.categories.slice(0, 2) }, 100);
    expect(unknown).toContain("The context window of this model is unknown.");
    expect(unknown).not.toContain("□");
    expect(unknown).toMatch(/■ Instructions +3\.4k/);
  });
});
