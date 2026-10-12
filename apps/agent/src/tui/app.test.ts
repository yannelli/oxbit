import { describe, expect, test } from "vitest";
import { FakeConnection, streamText, type FakeOptions, type Script } from "./fake-connection.js";
import { run } from "./index.js";
import { KEYS, terminal, waitFor } from "./test-terminal.js";
import { width } from "./width.js";

async function start(scripts: Script[] = [], options: FakeOptions = {}, columns = 100) {
  const term = terminal(columns, 30);
  const connection = new FakeConnection(scripts, options);
  const done = run(connection, { cwd: "/work/project", debug: true, ...term.streams });
  const frame = () => term.stdout.frame();
  const until = (pattern: string | RegExp) =>
    waitFor(() => typeof pattern === "string" ? frame().includes(pattern) : pattern.test(frame()), frame);
  const type = (text: string) => term.stdin.press(...text);
  const exit = async () => {
    term.stdin.press(KEYS.ctrlC, KEYS.ctrlC);
    await done;
  };
  await until("Ask anything");
  return { term, connection, frame, until, type, exit, press: (...keys: string[]) => term.stdin.press(...keys) };
}

const tool = (toolCallId: string, title: string, kind: string, extra: object = {}) =>
  ({ sessionUpdate: "tool_call", toolCallId, title, kind, status: "in_progress", ...extra });

describe("tui", () => {
  test("streams a Markdown message into the live area, then scrollback", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ui = await start([async (context) => {
      context.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reading the code first." } });
      await streamText(context, "Here is **bold** text with `code`.\n\n```ts\nconst a = 1;\n");
      await gate;
      await streamText(context, "```\n\nDone.");
    }]);
    ui.type("hello");
    ui.press(KEYS.enter);
    await ui.until("const a = 1;");
    expect(ui.frame()).toContain("Here is bold text with code.");
    expect(ui.frame()).toContain("╭─ typescript");
    expect(ui.frame()).not.toContain("Done.");
    expect(ui.frame()).toMatch(/Working…|Thinking…/);
    release();
    await ui.until("Done.");
    await ui.until("Ask anything");
    expect(ui.frame()).toContain("› hello");
    expect(ui.frame()).toContain("∴ Thought (ctrl+o to expand)");
    expect(ui.frame()).toContain("╰─");
    await ui.exit();
  });

  test("renders a tool card with a diff and line numbers", async () => {
    const ui = await start([async (context) => {
      context.update(tool("t1", "Edit src/app.ts", "edit", { rawInput: { path: "src/app.ts" } }));
      context.update({ sessionUpdate: "tool_call_update", toolCallId: "t1",
        content: [{ type: "diff", path: "/work/project/src/app.ts", oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" }] });
      context.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "Saved src/app.ts" });
    }]);
    ui.type("edit it");
    ui.press(KEYS.enter);
    await ui.until("Updated src/app.ts");
    const frame = ui.frame();
    expect(frame).toContain("✎ Edit src/app.ts");
    expect(frame).toContain("Updated src/app.ts: 2 added, 1 removed");
    expect(frame).toMatch(/2 - b/);
    expect(frame).toMatch(/2 \+ B/);
    expect(frame).toMatch(/4 \+ d/);
    await ui.exit();
  });

  test("renders a subagent's forwarded tool card", async () => {
    const ui = await start([async (context) => {
      context.update(tool("t1", "Task: Update the app", "other"));
      context.update(tool("t1/c1", "Edit src/app.ts", "edit", { rawInput: { path: "src/app.ts" }, _meta: { oxbit: { subagentOf: "t1" } } }));
      context.update({ sessionUpdate: "tool_call_update", toolCallId: "t1/c1", _meta: { oxbit: { subagentOf: "t1" } },
        content: [{ type: "diff", path: "/work/project/src/app.ts", oldText: "a\n", newText: "b\n" }] });
      context.update({ sessionUpdate: "tool_call_update", toolCallId: "t1/c1", status: "completed", rawOutput: "Saved src/app.ts", _meta: { oxbit: { subagentOf: "t1" } } });
      context.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "Updated src/app.ts" });
    }]);
    ui.type("delegate");
    ui.press(KEYS.enter);
    await ui.until("Updated src/app.ts: 1 added, 1 removed");
    expect(ui.frame()).toContain("Task: Update the app");
    expect(ui.frame()).toContain("✎ Edit src/app.ts");
    await ui.exit();
  });

  test("asks for permission and remembers allow for this session", async () => {
    const ui = await start([async (context) => {
      for (const [id, command] of [["t1", "npm test"], ["t2", "npm run lint"], ["t3", "rm -rf build"]]) {
        context.update(tool(id, command, "execute", { rawInput: { command } }));
        const outcome = await context.permission({ toolCallId: id, title: command, kind: "execute", status: "pending", rawInput: { command } });
        const allowed = outcome.outcome.outcome === "selected" && outcome.outcome.optionId === "allow";
        context.update({ sessionUpdate: "tool_call_update", toolCallId: id, status: allowed ? "completed" : "failed", rawOutput: allowed ? "ok" : "The user denied this tool call" });
      }
    }]);
    ui.type("run checks");
    ui.press(KEYS.enter);
    await ui.until("Run this command?");
    expect(ui.frame()).toContain("$ npm test");
    expect(ui.frame()).toContain("1. Yes");
    expect(ui.frame()).toContain("2. Yes, and allow `npm` commands for this session");
    expect(ui.frame()).toContain("3. No, tell the agent what to do instead");
    ui.press(KEYS.down, KEYS.enter);
    await ui.until("$ rm -rf build");
    expect(ui.connection.outcomes).toHaveLength(2);
    ui.press(KEYS.escape);
    await ui.until("Ask anything");
    expect(ui.connection.outcomes.map((item) => item.outcome)).toEqual([
      { outcome: "selected", optionId: "allow" }, { outcome: "selected", optionId: "allow" }, { outcome: "selected", optionId: "reject" }]);
    expect(ui.frame()).toContain("rm -rf build · failed");
    await ui.exit();
  });

  test("completes slash commands from available_commands_update", async () => {
    const ui = await start([], { commands: [{ name: "compact", description: "Summarize the conversation" },
      { name: "goal", description: "Set a goal", input: { hint: "<objective>" } }] });
    ui.type("/com");
    await ui.until("Summarize the conversation");
    expect(ui.frame()).toContain("❯ /compact");
    ui.press(KEYS.tab);
    await ui.until("› /compact");
    ui.press(KEYS.ctrlU);
    ui.type("/go");
    await ui.until("/goal <objective>");
    ui.press(KEYS.enter);
    await ui.until(/› \/goal\s/);
    ui.type("ship it");
    ui.press(KEYS.enter);
    await waitFor(() => ui.connection.prompts.length === 1, ui.frame);
    expect(ui.connection.prompts).toEqual(["/goal ship it"]);
    ui.type("/mo");
    await ui.until("Choose the model and reasoning effort");
    await ui.exit();
  });

  test("Shift+Tab cycles the mode through the connection", async () => {
    const ui = await start();
    expect(ui.frame()).toContain("◇ ask");
    ui.press(KEYS.shiftTab);
    await ui.until("⏵⏵ accept edits");
    ui.press(KEYS.shiftTab);
    await ui.until("⏵⏵⏵ full auto");
    ui.press(KEYS.shiftTab);
    await ui.until("◇ ask");
    expect(ui.connection.modes).toEqual(["accept-edits", "full-auto", "ask"]);
    await ui.exit();
  });

  test("shows title, model, plan, context, goal and loop in the status line", async () => {
    const ui = await start([async (context) => {
      context.update({ sessionUpdate: "session_info_update", title: "Fix the login bug" });
      context.update({ sessionUpdate: "usage_update", used: 42000, size: 100000 });
      context.update({ sessionUpdate: "session_info_update", _meta: { oxbit: { goal: { objective: "Ship", status: "active" }, loop: { iteration: 2, max: 5, interval: "5m" } } } });
      context.update({ sessionUpdate: "plan", entries: [{ content: "Read the code", status: "completed" }, { content: "Fix it", status: "in_progress" }, { content: "Test", status: "pending" }] });
    }], { info: { provider: "openai", usingChatGPTPlan: true } });
    ui.type("go");
    ui.press(KEYS.enter);
    await ui.until("42% context");
    await ui.until("Ask anything");
    const frame = ui.frame();
    for (const text of ["Using ChatGPT plan", "Fix the login bug", "GPT-5.1", "◎ goal active", "↻ loop 2/5 · every 5m", "☰ Plan · 1/3 done", "☒ Read the code", "▶ Fix it", "☐ Test"])
      expect(frame).toContain(text);
    await ui.exit();
  });

  test("fits 60 columns", async () => {
    const ui = await start([async (context) => {
      await streamText(context, `# A heading that is long enough to wrap at sixty columns for sure\n\n| Column one | Column two | Column three |\n|---|---|---|\n| ${"wide ".repeat(8)}| 世界 | 👍 |\n\n\`\`\`sh\n${"echo long ".repeat(12)}\n\`\`\`\n`, 40, 1);
      context.update(tool("t1", `Edit ${"deep/".repeat(10)}file.ts`, "edit"));
      context.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed",
        content: [{ type: "diff", path: "/work/project/a.ts", oldText: "x\n", newText: `${"y".repeat(90)}\n` }] });
    }], { info: { usingChatGPTPlan: true } }, 60);
    ui.type("narrow");
    ui.press(KEYS.enter);
    await ui.until("Updated a.ts");
    await ui.until("Ask anything");
    for (const frame of ui.term.stdout.frames())
      for (const line of frame.split("\n")) expect(width(line), line).toBeLessThanOrEqual(60);
    expect(ui.frame()).toContain("Using ChatGPT plan");
    expect(ui.frame()).toContain("◇ ask");
    await ui.exit();
  });

  test("Ctrl+C stops the turn, then exits on the second press", async () => {
    const ui = await start([async (context) => {
      await streamText(context, "Working on it");
      await context.sleep(60000);
    }]);
    ui.type("long task");
    ui.press(KEYS.enter);
    await ui.until("Working on it");
    ui.press(KEYS.ctrlC);
    await ui.until("Interrupted");
    expect(ui.connection.cancels).toBe(1);
    expect(ui.frame()).toContain("Press Ctrl+C again to exit");
    await ui.exit();
  });

  test("Esc stops the running turn", async () => {
    const ui = await start([async (context) => {
      await streamText(context, "Thinking hard");
      await context.sleep(60000);
    }]);
    ui.type("task");
    ui.press(KEYS.enter);
    await ui.until("Thinking hard");
    ui.press(KEYS.escape);
    await ui.until("Interrupted");
    expect(ui.connection.cancels).toBe(1);
    await ui.exit();
  });

  test("picks a model, completes @files and resumes a session", async () => {
    const ui = await start([], { files: ["src/login.ts", "docs/catalog.md"], sessions: [{ sessionId: "old-1", title: "Earlier work", updatedAt: "2026-10-10T12:00:00Z" }] });
    ui.press("\x10");
    await ui.until("Choose a model");
    ui.press(KEYS.down, KEYS.enter);
    await ui.until("GPT-5.1 mini");
    expect(ui.connection.models).toEqual(["gpt-5.1-mini"]);
    ui.type("read @log");
    await ui.until("❯ src/login.ts");
    ui.press(KEYS.tab);
    await ui.until("› read @src/login.ts");
    ui.press(KEYS.ctrlU);
    ui.type("/resume");
    ui.press(KEYS.enter);
    await ui.until("Resume a session");
    expect(ui.frame()).toContain("Earlier work");
    ui.press(KEYS.enter);
    await ui.until("Earlier answer.");
    expect(ui.frame()).toContain("── Resumed Earlier work ──");
    await ui.exit();
  });

  test("shows flushed tool output in full with ctrl+o", async () => {
    const output = Array.from({ length: 40 }, (_, index) => `out ${index + 1}`).join("\n");
    const ui = await start([async (context) => {
      context.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Plan the check." } });
      context.update(tool("x1", "npm run check", "execute"));
      context.update({ sessionUpdate: "tool_call_update", toolCallId: "x1", status: "completed", rawOutput: output });
      await streamText(context, "Checked.");
    }]);
    ui.type("check");
    ui.press(KEYS.enter);
    await ui.until("Checked.");
    await ui.until("Ask anything");
    expect(ui.frame()).toContain("+35 lines (ctrl+o to expand)");
    expect(ui.frame()).not.toContain("out 1\n");
    ui.press(KEYS.ctrlO);
    await ui.until("Details 2/2");
    expect(ui.frame()).toContain("lines 1-21 of 42");
    expect(ui.frame()).toContain("out 6");
    expect(ui.frame()).not.toContain("out 25");
    ui.press("\x1b[6~");
    await ui.until("out 25");
    expect(ui.frame()).toContain("lines 21-41 of 42");
    ui.press(KEYS.left);
    await ui.until("Details 1/2");
    expect(ui.frame()).toContain("Plan the check.");
    ui.press(KEYS.escape);
    await ui.until("Ask anything");
    expect(ui.frame()).not.toContain("Details");
    await ui.exit();
  });

  test("shows an edit diff once while asking for permission", async () => {
    const diff = { type: "diff", path: "/work/project/a.ts", oldText: "a\nb\n", newText: "a\nB\n" };
    const ui = await start([async (context) => {
      context.update(tool("e1", "Edit a.ts", "edit"));
      await context.permission({ toolCallId: "e1", title: "Edit a.ts", kind: "edit", status: "pending", content: [diff] });
    }, async (context) => {
      context.update(tool("e2", "Edit a.ts", "edit", { content: [diff] }));
      await context.permission({ toolCallId: "e2", title: "Edit a.ts", kind: "edit", status: "pending", content: [diff] });
    }]);
    const count = () => ui.frame().split("2 + B").length - 1;
    for (const prompt of ["one", "two"]) {
      ui.type(prompt);
      ui.press(KEYS.enter);
      await ui.until("Apply this edit?");
      expect(count()).toBe(1);
      ui.press("1");
      await ui.until("Ask anything");
    }
    await ui.exit();
  });

  test("edits multi-line input and recalls history", async () => {
    const ui = await start();
    ui.type("first");
    ui.press(KEYS.altEnter);
    ui.type("second");
    ui.press(KEYS.shiftEnter);
    ui.type("third");
    await ui.until("third");
    ui.press(KEYS.enter);
    await waitFor(() => ui.connection.prompts.length === 1, ui.frame);
    expect(ui.connection.prompts[0]).toBe("first\nsecond\nthird");
    await ui.until("Done.");
    ui.press(KEYS.up);
    await ui.until(/› first\n/);
    await ui.exit();
  });

  test("walks history past a slash command without opening the menu", async () => {
    const ui = await start();
    ui.type("/help");
    ui.press(KEYS.enter);
    await ui.until("Keys");
    ui.press(KEYS.escape);
    await waitFor(() => !ui.frame().includes("Keys"), ui.frame);
    ui.type("hello");
    ui.press(KEYS.enter);
    await ui.until("Done.");
    ui.press(KEYS.up);
    await ui.until(/│ › hello +│/);
    ui.press(KEYS.up);
    await ui.until(/│ › \/help +│/);
    expect(ui.frame()).not.toContain("Show keys and commands");
    ui.press(KEYS.down);
    await ui.until(/│ › hello +│/);
    await ui.exit();
  });
});
