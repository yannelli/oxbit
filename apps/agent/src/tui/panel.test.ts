import { describe, expect, test } from "vitest";
import { FakeConnection, FakeSettings, streamText, type FakeOptions, type Script } from "./fake-connection.js";
import { run } from "./index.js";
import { KEYS, terminal, waitFor } from "./test-terminal.js";

const SERVER = [
  { name: "config", description: "Show settings", input: { hint: "[setting value]" } },
  { name: "skills", description: "List skills" },
  { name: "hooks", description: "List hooks" },
  { name: "mcp", description: "Show MCP servers", input: { hint: "reload" } },
  { name: "instructions", description: "List instruction files" },
  { name: "providers", description: "List providers" },
];

async function start(options: FakeOptions = {}, scripts: Script[] = []) {
  const term = terminal(100, 30);
  const settings = options.settings;
  const connection = new FakeConnection(scripts, { commands: SERVER, ...options });
  const done = run(connection, { cwd: "/work/project", debug: true, ...term.streams });
  const frame = () => term.stdout.frame();
  const until = (pattern: string | RegExp) =>
    waitFor(() => typeof pattern === "string" ? frame().includes(pattern) : pattern.test(frame()), frame);
  const press = (...keys: string[]) => term.stdin.press(...keys);
  const command = (text: string) => press(...text, KEYS.enter);
  await until("Ask anything");
  return { connection, settings: settings!, frame, until, press, command, type: (text: string) => press(...text),
    exit: async () => { press(KEYS.ctrlC, KEYS.ctrlC); await done; } };
}

describe("settings panels", () => {
  test("opens each panel from its command and closes it with esc or Ctrl+C", async () => {
    const ui = await start({ settings: new FakeSettings() });
    const panels = [["config", "Settings"], ["skills", "Skills"], ["hooks", "Hooks"], ["mcp", "MCP servers"], ["instructions", "Instructions"], ["providers", "Providers"]];
    for (const [id, title] of panels) {
      ui.type(`/${id}`);
      await ui.until(`/${id}`);
      ui.press(KEYS.enter);
      await ui.until(new RegExp(`│ ${title} +│`));
      ui.press(KEYS.escape);
      await ui.until("Ask anything");
    }
    expect(ui.settings.calls).toEqual(panels.map(([id]) => `panel ${id}`));
    expect(ui.settings.contexts[0]).toMatchObject({ cwd: "/work/project", sessionId: "session-1" });
    expect(ui.settings.contexts[0].signal).toBeInstanceOf(AbortSignal);
    ui.command("/hooks");
    await ui.until("~/.claude/settings.json");
    ui.press(KEYS.ctrlC);
    await ui.until("Ask anything");
    await ui.exit();
  });

  test("toggles a row with space and cycles a choice with the arrows", async () => {
    const ui = await start({ settings: new FakeSettings() });
    ui.command("/config");
    await ui.until("❯ [x] Auto-compact");
    const frame = ui.frame();
    for (const text of ["Session", "Trust", "[ ] Claude Code hooks", "Permission mode ◂ Ask ▸", "Saved to ~/.oxbit/agent/settings.json", "space toggle"])
      expect(frame).toContain(text);
    ui.press(" ");
    await ui.until("❯ [ ] Auto-compact");
    ui.press(KEYS.down, KEYS.right);
    await ui.until("❯ Permission mode ◂ Accept edits ▸");
    await ui.until("⏵⏵ accept edits");
    expect(ui.connection.modes).toEqual(["accept-edits"]);
    expect(ui.settings.calls).toEqual(["panel config", "toggle config autoCompact false", "panel config", "choose config mode accept-edits", "panel config"]);
    await ui.exit();
  });

  test("asks two inputs, masks the secret, takes a paste and reloads the session", async () => {
    const ui = await start({ settings: new FakeSettings() });
    ui.command("/providers");
    await ui.until("❯ OpenAI");
    expect(ui.frame()).toContain("GPT-5.1 · openai");
    ui.press(KEYS.down, KEYS.enter);
    await ui.until("Base URL: https://api.example.com/v1");
    expect(ui.frame()).toContain("Connect (1/2)");
    ui.press(KEYS.enter);
    await ui.until("API key: ");
    expect(ui.frame()).toContain("sk-…");
    ui.type("sk-");
    ui.press("\x1b[200~secret\n\x1b[201~");
    await ui.until("•••••••••");
    expect(ui.frame()).not.toContain("sk-secret");
    ui.press(KEYS.enter);
    await ui.until("Connected to the custom provider");
    expect(ui.settings.calls).toContain('act providers custom connect ["https://api.example.com/v1","sk-secret"]');
    expect(ui.connection.loads).toEqual(["session-1"]);
    await ui.until("GPT-5.1 · custom");
    expect(ui.frame()).not.toContain("Earlier answer.");
    await ui.exit();
  });

  test("lists several actions, shows sign-in progress in full and cancels it with esc", async () => {
    const ui = await start({ settings: new FakeSettings() });
    ui.command("/providers");
    await ui.until("enter actions");
    ui.press(KEYS.enter);
    await ui.until("❯ Sign in with ChatGPT");
    expect(ui.frame()).toContain("  Set API key");
    ui.press(KEYS.enter);
    await ui.until("Open https://auth.example.com/device?code=WXYZ-1234&client=oxbit-agent-cli in a browser to sign in");
    expect(ui.frame()).toContain("Working…");
    ui.press(KEYS.escape);
    await waitFor(() => ui.settings.aborted === 1, ui.frame);
    await ui.until("❯ OpenAI");
    expect(ui.frame()).not.toContain("auth.example.com");
    ui.press(KEYS.enter, KEYS.down, KEYS.enter);
    await ui.until("Set API key");
    await ui.until("API key: ");
    ui.press(KEYS.escape);
    await ui.until("enter actions");
    expect(ui.settings.calls.filter((call) => call.startsWith("act"))).toEqual(['act providers openai signin []']);
    await ui.exit();
  });

  test("a skill action closes the panel and fills the prompt", async () => {
    const ui = await start({ settings: new FakeSettings() });
    ui.command("/skills");
    await ui.until("enter use in prompt");
    ui.press(KEYS.enter);
    await ui.until("› /review");
    expect(ui.frame()).not.toContain("Use in prompt");
    expect(ui.settings.calls.at(-1)).toBe('act skills review use []');
    await ui.exit();
  });

  test("refuses an action that reloads the agent while a turn runs", async () => {
    const long: Script = async (context) => {
      await streamText(context, "Working on it");
      await context.sleep(60000);
    };
    const ui = await start({ settings: new FakeSettings() }, [long]);
    ui.type("task");
    ui.press(KEYS.enter);
    await ui.until("Working on it");
    ui.command("/providers");
    await ui.until("❯ OpenAI");
    ui.press(KEYS.down, KEYS.enter);
    await ui.until("Wait for the turn to finish");
    expect(ui.frame()).not.toContain("Base URL");
    expect(ui.settings.calls).toEqual(["panel providers"]);
    ui.press(KEYS.escape);
    await ui.until("esc to interrupt");
    ui.press(KEYS.escape);
    await ui.until("Interrupted");
    await ui.exit();
  });

  test("sends panel commands with arguments to the agent and lists each command once", async () => {
    const ui = await start({ settings: new FakeSettings() });
    ui.type("/mc");
    await ui.until("/mcp [reload]");
    expect(ui.frame()).toContain("Add, remove, trust and sign in to MCP servers");
    expect(ui.frame()).not.toContain("Show MCP servers");
    ui.press(KEYS.ctrlU);
    ui.command("/mcp reload");
    await waitFor(() => ui.connection.prompts.length === 1, ui.frame);
    await ui.until("Ask anything");
    ui.command("/config auto-compact off");
    await waitFor(() => ui.connection.prompts.length === 2, ui.frame);
    expect(ui.connection.prompts).toEqual(["/mcp reload", "/config auto-compact off"]);
    expect(ui.settings.calls).toEqual([]);
    await ui.exit();
  });

  test("without a settings manager the commands go to the agent", async () => {
    const ui = await start();
    ui.type("/co");
    await ui.until("Show settings");
    expect(ui.frame()).not.toContain("Settings: permission mode");
    ui.press(KEYS.ctrlU);
    ui.command("/skills");
    await waitFor(() => ui.connection.prompts.length === 1, ui.frame);
    expect(ui.connection.prompts).toEqual(["/skills"]);
    await ui.exit();
  });
});
