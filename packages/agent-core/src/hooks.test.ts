import { describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import { createHookRunner, hookSourcePaths, matchesHook, mergeOutcomes, type HookExec, type HookExecResult, type HookSource } from "./hooks.js";
import { chatText, chatTool } from "./test-models.js";
import { start, testHost, text } from "./test-host.js";

const settings = (hooks: unknown, dialect: HookSource["dialect"] = "claude", extra: object = {}): HookSource =>
  ({ dialect, path: `/home/.${dialect}/settings.json`, config: { hooks, ...extra } });
const command = (value: string, more: object = {}) => ({ type: "command", command: value, ...more });
const result = (code: number | null, stdout = "", stderr = ""): HookExecResult => ({ code, stdout, stderr });
const signal = () => new AbortController().signal;
const base = { session_id: "s1", cwd: "/repo" };
function fakeExec(answer: (command: string, stdin: any) => HookExecResult | Promise<HookExecResult>) {
  const calls: [string, Parameters<HookExec>[1]][] = [];
  const exec: HookExec = async (cmd, options) => {
    calls.push([cmd, options]);
    return answer(cmd, JSON.parse(options.stdin));
  };
  return { exec, calls };
}

describe("matchesHook", () => {
  it("matches all, exact lists and unanchored regexes", () => {
    expect(matchesHook("", ["x"])).toBe(true);
    expect(matchesHook("*", ["x"])).toBe(true);
    expect(matchesHook("Edit|Write", ["write_file", "Write"])).toBe(true);
    expect(matchesHook("Edit, Bash", ["bash", "Bash"])).toBe(true);
    expect(matchesHook("Edit", ["NotebookEdit"])).toBe(false);
    expect(matchesHook("Edit.*", ["NotebookEdit"])).toBe(true);
    expect(matchesHook("mcp__memory__.*", ["mcp__memory__save"])).toBe(true);
    expect(matchesHook("(", ["("])).toBe(false);
  });
});

describe("mergeOutcomes", () => {
  it("lets deny beat ask and allow, and a block deny a PreToolUse even with allow", () => {
    expect(mergeOutcomes("PreToolUse", [{ permission: "allow" }, { permission: "deny", permissionReason: "No" }, { permission: "ask" }]))
      .toEqual({ permission: "deny", permissionReason: "No" });
    expect(mergeOutcomes("PreToolUse", [{ permission: "allow" }, { block: true, reason: "Exit 2" }]))
      .toEqual({ block: true, reason: "Exit 2", permission: "deny", permissionReason: "Exit 2" });
    expect(mergeOutcomes("Stop", [{ additionalContext: "a", updatedInput: { x: 1 } }, { additionalContext: "b", updatedInput: { x: 2 }, continue: false }]))
      .toEqual({ continue: false, updatedInput: { x: 2 }, additionalContext: "a\n\nb" });
  });
});

describe("createHookRunner", () => {
  it("sends Claude stdin with tool name aliases, env and the timeout in ms", async () => {
    const { exec, calls } = fakeExec(() => result(0));
    const runner = createHookRunner({ sources: [settings({ PreToolUse: [{ matcher: "Read", hooks: [command("check", { timeout: 5 })] }] }),
      settings({ PreToolUse: [{ matcher: "read_file", hooks: [command("oxbit-check")] }] }, "oxbit")], exec, transcriptPath: (id) => `/t/${id}.jsonl` });
    await runner.run("PreToolUse", { ...base, hook_event_name: "PreToolUse", tool_name: "read_file", tool_input: { path: "a.ts" } }, signal());
    expect(calls.map(([cmd, options]) => [cmd, JSON.parse(options.stdin).tool_name, options.timeoutMs, options.cwd, options.env])).toEqual([
      ["check", "Read", 5000, "/repo", { CLAUDE_PROJECT_DIR: "/repo", OXBIT_PROJECT_DIR: "/repo" }],
      ["oxbit-check", "read_file", 600000, "/repo", { CLAUDE_PROJECT_DIR: "/repo", OXBIT_PROJECT_DIR: "/repo" }],
    ]);
    expect(JSON.parse(calls[0][1].stdin)).toEqual({ transcript_path: "/t/s1.jsonl", session_id: "s1", cwd: "/repo", hook_event_name: "PreToolUse",
      tool_name: "Read", oxbit_tool_name: "read_file", tool_input: { path: "a.ts" } });
  });
  it("maps exit 2, JSON output and plain stdout by event", async () => {
    const answers: Record<string, HookExecResult> = {
      block: result(2, "", "Not on main\n"),
      json: result(0, JSON.stringify({ systemMessage: "Checked", hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "Prod",
        updatedInput: { path: "b.ts" }, additionalContext: "Note" } })),
      legacy: result(0, JSON.stringify({ decision: "approve" })),
      plain: result(0, "Branch: main\n"),
      stop: result(0, JSON.stringify({ decision: "block", reason: "Run tests" })),
    };
    const run = (name: string, event: any, extra = {}) => createHookRunner({ sources: [settings({ [event]: [{ hooks: [command(name)] }] })],
      exec: async (cmd) => answers[cmd] }).run(event, { ...base, hook_event_name: event, ...extra }, signal());
    expect(await run("block", "PreToolUse", { tool_name: "bash" })).toEqual({ block: true, reason: "Not on main", permission: "deny", permissionReason: "Not on main" });
    expect(await run("block", "Stop")).toEqual({ block: true, reason: "Not on main" });
    expect(await run("json", "PreToolUse", { tool_name: "read_file" })).toEqual({ permission: "ask", permissionReason: "Prod", updatedInput: { path: "b.ts" },
      additionalContext: "Note", systemMessage: "Checked" });
    expect(await run("legacy", "PreToolUse", { tool_name: "read_file" })).toEqual({ permission: "allow" });
    expect(await run("plain", "UserPromptSubmit", { prompt: "Hi" })).toEqual({ additionalContext: "Branch: main" });
    expect(await run("plain", "Stop")).toEqual({});
    expect(await run("stop", "Stop")).toEqual({ block: true, reason: "Run tests" });
  });
  it("records other exit codes, exit 2 on SessionStart and timeouts as warnings", async () => {
    vi.useFakeTimers();
    try {
      const onWarning = vi.fn();
      const runner = createHookRunner({ onWarning, sources: [settings({ SessionStart: [{ matcher: "startup", hooks: [command("fail"), command("two")] }],
        PreCompact: [{ hooks: [command("hang", { timeout: 1 }), command("strict", { timeout: 1, onFailure: "block" })] }] })],
      exec: (cmd) => cmd === "fail" ? Promise.resolve(result(1, "", "boom")) : cmd === "two" ? Promise.resolve(result(2, "", "no")) : new Promise(() => {}) });
      expect(await runner.run("SessionStart", { ...base, source: "startup" }, signal())).toEqual({});
      expect(await runner.run("SessionStart", { ...base, source: "resume" }, signal())).toEqual({});
      const compact = runner.run("PreCompact", { ...base, trigger: "auto" }, signal());
      await vi.advanceTimersByTimeAsync(1000);
      expect(await compact).toEqual({ block: true, reason: '/home/.claude/settings.json: PreCompact hook "strict" timed out after 1 s' });
      expect(runner.warnings).toEqual([
        '/home/.claude/settings.json: SessionStart hook "fail" exited with 1: boom',
        '/home/.claude/settings.json: SessionStart hook "two" exited with 2: no',
        '/home/.claude/settings.json: PreCompact hook "hang" timed out after 1 s',
        '/home/.claude/settings.json: PreCompact hook "strict" timed out after 1 s',
      ]);
      expect(onWarning).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it("runs a handler defined in two files once, applies if rules, skips other types and honors disableAllHooks", async () => {
    const { exec, calls } = fakeExec(() => result(0));
    const group = { matcher: "Bash", hooks: [command("guard"), command("git-only", { if: "Bash(git *)" }), { type: "http", url: "https://x" },
      command("ts-only", { if: "Edit(*.ts)" })] };
    const runner = createHookRunner({ sources: [settings({ PreToolUse: [group] }), settings({ PreToolUse: [group] }, "codex")], exec });
    const bash = (value: string) => runner.run("PreToolUse", { ...base, tool_name: "bash", tool_input: { command: value } }, signal());
    await bash("FOO=1 git status && ls");
    await bash("npm test");
    expect(calls.map(([cmd]) => cmd)).toEqual(["guard", "git-only", "guard"]);
    expect(runner.warnings).toEqual(["/home/.claude/settings.json: skipped a http PreToolUse hook; Oxbit runs command hooks only",
      "/home/.codex/settings.json: skipped a http PreToolUse hook; Oxbit runs command hooks only"]);
    const edits = createHookRunner({ sources: [settings({ PreToolUse: [{ hooks: [command("ts-only", { if: "Edit(*.ts)" })] }] })], exec });
    calls.length = 0;
    await edits.run("PreToolUse", { ...base, tool_name: "edit_file", tool_input: { path: "src/a.ts" } }, signal());
    await edits.run("PreToolUse", { ...base, tool_name: "edit_file", tool_input: { path: "src/a.js" } }, signal());
    await edits.run("Stop", { ...base }, signal());
    expect(calls.map(([cmd]) => cmd)).toEqual(["ts-only"]);
    const off = createHookRunner({ sources: [settings({ Stop: [{ hooks: [command("x")] }] }), settings(undefined, "claude", { disableAllHooks: true })], exec });
    calls.length = 0;
    await off.run("Stop", base, signal());
    expect(calls).toEqual([]);
  });
  it("quotes args, reads sources per cwd and lists source paths", async () => {
    const { exec, calls } = fakeExec(() => result(0));
    const sources = vi.fn((cwd: string) => [settings({ Stop: [{ hooks: [command("/bin/notify", { args: ["it's done", "now"] })] }] })].map((s) => ({ ...s, path: cwd })));
    await createHookRunner({ sources, exec }).run("Stop", base, signal());
    expect(sources).toHaveBeenCalledWith("/repo");
    expect(calls[0][0]).toBe(`'/bin/notify' 'it'\\''s done' 'now'`);
    expect(hookSourcePaths("/h", "/p", { claude: true, codex: true }).map((source) => `${source.dialect}:${source.path}`)).toEqual([
      "oxbit:/h/.oxbit/agent/settings.json", "oxbit:/p/.oxbit/settings.json", "claude:/h/.claude/settings.json", "claude:/p/.claude/settings.json",
      "claude:/p/.claude/settings.local.json", "codex:/h/.codex/hooks.json", "codex:/p/.codex/hooks.json"]);
    expect(hookSourcePaths("/h", "/p")).toHaveLength(2);
  });
  it("blocks a bash call through Agent with a Claude PreToolUse hook that exits 2", async () => {
    const { exec, calls } = fakeExec((_cmd, stdin) => stdin.tool_input.command.startsWith("rm") ? result(2, "", "rm is blocked") : result(0));
    const hooks = createHookRunner({ sources: [settings({ PreToolUse: [{ matcher: "Bash", hooks: [command("guard.sh")] }] })], exec });
    const t = testHost([chatTool("call_1", "bash", { command: "rm -rf build" }), chatText("Ok")], { terminal: true, extensions: { hooks } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    expect(await agent.prompt(sessionId, text("Clean"))).toEqual({ stopReason: "end_turn" });
    expect(t.client.filter(([method]) => method.startsWith("terminal/"))).toEqual([]);
    expect(t.messages().at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "rm is blocked" });
    expect(JSON.parse(calls[0][1].stdin)).toEqual({ transcript_path: "", session_id: sessionId, cwd: "/root", hook_event_name: "PreToolUse",
      permission_mode: "default", tool_name: "Bash", oxbit_tool_name: "bash", tool_input: { command: "rm -rf build" }, tool_use_id: "call_1" });
  });
});
