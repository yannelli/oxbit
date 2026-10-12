import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { INIT_PROMPT } from "./controller.js";
import { FakeConnection, streamText, type Script } from "./fake-connection.js";
import { run } from "./index.js";
import { KEYS, terminal, waitFor } from "./test-terminal.js";

async function start(scripts: Script[] = [], { fullscreen = true, cwd = "/work/project" } = {}) {
  const term = terminal(100, 30);
  const connection = new FakeConnection(scripts);
  const done = run(connection, { cwd, debug: true, fullscreen, ...term.streams });
  const frame = () => term.stdout.frame();
  const lines = () => frame().replace(/\n$/, "").split("\n");
  const until = (pattern: string | RegExp) =>
    waitFor(() => typeof pattern === "string" ? frame().includes(pattern) : pattern.test(frame()), frame);
  const gone = (text: string) => waitFor(() => !frame().includes(text), frame);
  const press = (...keys: string[]) => term.stdin.press(...keys);
  const command = (text: string) => press(...text, KEYS.enter);
  const written = () => term.stdout.writes.join("");
  const exit = async () => {
    press(KEYS.ctrlC, KEYS.ctrlC);
    return done;
  };
  await until("Ask anything");
  return { term, connection, frame, lines, until, gone, press, command, written, exit };
}

const rows = Array.from({ length: 60 }, (_, index) => `- row ${String(index + 1).padStart(2, "0")}`).join("\n");
const reply = (text: string): Script => async (context) => { await streamText(context, text, 400, 1); };

describe("fullscreen", () => {
  test("pins the prompt and status line to the last rows while the transcript grows", async () => {
    const ui = await start([reply(rows)]);
    expect(ui.lines()).toHaveLength(30);
    expect(ui.frame()).toContain("Oxbit Agent");
    ui.command("list rows");
    await ui.until("row 60");
    await ui.until("Ask anything");
    const lines = ui.lines();
    expect(lines).toHaveLength(30);
    expect(lines.at(-1)).toContain("ask (shift+tab)");
    expect(lines.at(-2)).toMatch(/^╰─+╯$/);
    expect(lines.at(-3)).toContain("Ask anything");
    expect(lines.at(-4)).toMatch(/^╭─+╮$/);
    expect(lines.at(-6)).toContain("row 60");
    expect(ui.frame()).not.toContain("Oxbit Agent");
    await ui.exit();
  });

  test("PageUp shows older output and the scrolled notice; PageDown and End return to the latest", async () => {
    const ui = await start([reply(rows)]);
    ui.command("list rows");
    await ui.until("row 60");
    await ui.until("Ask anything");
    ui.press(KEYS.pageUp);
    await ui.until("scrolled up · pgdn or end returns to the latest");
    expect(ui.frame()).not.toContain("row 60");
    expect(ui.lines()).toHaveLength(30);
    expect(ui.lines().at(-3)).toContain("Ask anything");
    ui.press(KEYS.pageUp, KEYS.pageUp, KEYS.pageUp);
    await ui.until("Oxbit Agent");
    expect(ui.frame()).toContain("row 01");
    ui.press(KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageDown);
    await ui.gone("scrolled up");
    expect(ui.frame()).toContain("row 60");
    ui.press(KEYS.pageUp);
    await ui.until("scrolled up");
    ui.press(KEYS.end);
    await ui.gone("scrolled up");
    expect(ui.frame()).toContain("row 60");
    ui.press(KEYS.pageUp);
    await ui.until("scrolled up");
    const before = ui.term.stdout.writes.length;
    ui.press(KEYS.ctrlL);
    await ui.gone("scrolled up");
    expect(ui.term.stdout.writes.slice(before).join("")).toContain("\x1b[2J");
    expect(ui.frame()).toContain("row 60");
    await ui.exit();
  });

  test("/clear empties the transcript and opens a new session", async () => {
    const ui = await start([reply("The first answer.")]);
    ui.command("hello");
    await ui.until("The first answer.");
    await ui.until("Ask anything");
    ui.command("/clear");
    await ui.gone("The first answer.");
    expect(ui.frame()).not.toContain("› hello");
    expect(ui.frame()).toContain("Oxbit Agent");
    expect(await ui.exit()).toEqual({ sessionId: "session-2" });
  });

  test("/clear in inline mode also clears the scrollback", async () => {
    const ui = await start([], { fullscreen: false });
    ui.command("/clear");
    await waitFor(() => ui.written().includes("\x1b[2J\x1b[3J\x1b[H"), ui.frame);
    expect(await ui.exit()).toEqual({ sessionId: "session-2" });
  });

  test("/copy writes the last reply with OSC 52", async () => {
    const ui = await start([reply("Copy **this** text.")]);
    ui.command("/copy");
    await ui.until("There is no agent reply to copy yet");
    ui.command("hello");
    await ui.until("Copy this text.");
    await ui.until("Ask anything");
    ui.command("/copy");
    await ui.until("Copied the last reply to the clipboard");
    expect(ui.written()).toContain(`\x1b]52;c;${Buffer.from("Copy **this** text.").toString("base64")}\x07`);
    await ui.exit();
  });

  test("/export writes Markdown and refuses an existing file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oxbit-export-"));
    const ui = await start([async (context) => {
      context.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read", status: "in_progress" });
      context.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "ok" });
      await streamText(context, "The file is fine.");
    }], { cwd });
    ui.command("check a.ts");
    await ui.until("The file is fine.");
    await ui.until("Ask anything");
    ui.press(..."/export", KEYS.enter, KEYS.enter);
    const path = join(cwd, "oxbit-session-session-.md");
    await ui.until("Exported the conversation to");
    expect(readFileSync(path, "utf8")).toBe("# Oxbit Agent session\n\nSession `session-1`\n\n## User\n\ncheck a.ts\n\n## Agent\n\n"
      + "- Tool: Read a.ts (completed)\n\nThe file is fine.\n");
    ui.press(..."/export", KEYS.enter, KEYS.enter);
    await ui.until("already exists. Choose another path.");
    ui.command("/export notes.md");
    await waitFor(() => existsSync(join(cwd, "notes.md")), ui.frame);
    await ui.exit();
  });

  test("/init asks the agent to write AGENTS.md", async () => {
    const ui = await start([reply("Done.")]);
    ui.command("/init");
    await waitFor(() => ui.connection.prompts.length === 1, ui.frame);
    expect(ui.connection.prompts[0]).toBe(INIT_PROMPT);
    expect(INIT_PROMPT).toContain("AGENTS.md");
    await ui.exit();
  });

  test("sets the terminal title with a working marker and resets it on exit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ui = await start([async (context) => {
      context.update({ sessionUpdate: "session_info_update", title: "Fix the login test" });
      await gate;
    }]);
    expect(ui.written()).toContain("\x1b]2;Oxbit Agent\x07");
    ui.command("fix it");
    await waitFor(() => ui.written().includes("\x1b]2;● Fix the login test\x07"), ui.frame);
    release();
    await waitFor(() => ui.written().includes("\x1b]2;Fix the login test\x07"), ui.frame);
    await ui.exit();
    expect(ui.written().endsWith("\x1b]2;\x07")).toBe(true);
  });
});
