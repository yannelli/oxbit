import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeConnection, streamText, type Script, type ScriptContext } from "./fake-connection.js";
import { run } from "./index.js";
import { KEYS, terminal, waitFor } from "./test-terminal.js";

// Interactive: bunx tsx apps/agent/src/tui/demo.tsx [--light]
// Frames:      bunx tsx apps/agent/src/tui/demo.tsx --frames /tmp/oxbit-agent2/tui-frames
const CWD = "/work/oxbit";
const OLD = `export function validatePassword(input: string, hash: string) {
  if (!input) return false;
  const digest = sha256(input);
  return digest == hash;
}
`;
const NEW = `export function validatePassword(input: string, hash: string) {
  if (!input) return false;
  const digest = sha256(input.normalize("NFC"));
  return timingSafeEqual(digest, hash);
}
`;
const ANSWER = `## What changed

The login test failed because \`validatePassword\` compared hashes with \`==\` and skipped Unicode normalization, so a password typed with a composed "é" never matched.

1. Normalize input to **NFC** before hashing.
2. Compare digests with \`timingSafeEqual\` so the check runs in constant time.
3. Keep the empty-input guard.

\`\`\`ts
const digest = sha256(input.normalize("NFC"));
return timingSafeEqual(digest, hash);
\`\`\`

| Check | Before | After |
|-------|-------:|------:|
| login.test.ts | 3 failed | 0 failed |
| Duration | 1.9 s | 1.7 s |

> The fix is covered by the existing test; see [the Node crypto docs](https://nodejs.org/api/crypto.html) for timingSafeEqual.
`;

/** Gates that the frame driver opens to step the scripted turn. */
const gates = new Map<string, { wait: Promise<void>; open(): void }>();
const gate = (name: string) => {
  if (!gates.has(name)) {
    let open = () => {};
    const wait = new Promise<void>((resolve) => { open = resolve; });
    gates.set(name, { wait, open });
  }
  return gates.get(name)!;
};
const open = (name: string) => gate(name).open();
let stepped = false;
const step = (name: string) => stepped ? gate(name).wait : Promise.resolve();

const tool = (context: ScriptContext, id: string, title: string, kind: string, extra: object = {}) =>
  context.update({ sessionUpdate: "tool_call", toolCallId: id, title, kind, status: "in_progress", ...extra });
const done = (context: ScriptContext, id: string, output: string, status = "completed") =>
  context.update({ sessionUpdate: "tool_call_update", toolCallId: id, status, rawOutput: output });

const fix: Script = async (context) => {
  for (const chunk of ["The user wants the login test fixed. ", "Start with the auth module, then run ", "the test file to confirm."]) {
    context.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk } });
    await context.sleep(40);
  }
  await streamText(context, "I'll read the login flow first.", 6, 20);
  tool(context, "read", "Read src/auth/login.ts", "read", { rawInput: { path: "src/auth/login.ts" } });
  await context.sleep(150);
  done(context, "read", Array.from({ length: 42 }, (_, line) => `line ${line + 1}`).join("\n"));
  tool(context, "search", "Search validatePassword", "search");
  await context.sleep(100);
  done(context, "search", "src/auth/login.ts:12: export function validatePassword\nsrc/auth/login.test.ts:4: import { validatePassword }");
  context.update({ sessionUpdate: "plan", entries: [
    { content: "Find why login.test.ts fails", status: "completed" },
    { content: "Fix validatePassword", status: "in_progress" },
    { content: "Run the login tests", status: "pending" }] });
  context.update({ sessionUpdate: "session_info_update", title: "Fix the failing login test" });
  context.update({ sessionUpdate: "usage_update", used: 61000, size: 200000 });
  await step("edit");
  tool(context, "edit", "Edit src/auth/login.ts", "edit", { rawInput: { path: "src/auth/login.ts" } });
  context.update({ sessionUpdate: "tool_call_update", toolCallId: "edit", content: [{ type: "diff", path: `${CWD}/src/auth/login.ts`, oldText: OLD, newText: NEW }] });
  await context.sleep(150);
  done(context, "edit", "Saved src/auth/login.ts");
  context.update({ sessionUpdate: "plan", entries: [
    { content: "Find why login.test.ts fails", status: "completed" },
    { content: "Fix validatePassword", status: "completed" },
    { content: "Run the login tests", status: "in_progress" }] });
  tool(context, "test", "npm test -- login", "execute", { rawInput: { command: "npm test -- login" } });
  const outcome = await context.permission({ toolCallId: "test", title: "npm test -- login", kind: "execute", status: "pending", rawInput: { command: "npm test -- login" } });
  if (outcome.outcome.outcome !== "selected" || outcome.outcome.optionId !== "allow") return done(context, "test", "The user denied this tool call", "failed");
  context.update({ sessionUpdate: "tool_call_update", toolCallId: "test", content: [{ type: "terminal", terminalId: "term-1" }] });
  await context.sleep(300);
  done(context, "test", " ✓ login.test.ts (3 tests) 12ms\n ✓ session.test.ts (5 tests) 30ms\n\n Test Files  2 passed (2)\n      Tests  8 passed (8)\n[Exit code 0]");
  context.update({ sessionUpdate: "plan", entries: [
    { content: "Find why login.test.ts fails", status: "completed" },
    { content: "Fix validatePassword", status: "completed" },
    { content: "Run the login tests", status: "completed" }] });
  context.update({ sessionUpdate: "usage_update", used: 84000, size: 200000 });
  await streamText(context, ANSWER.slice(0, 260), 8, 8);
  await step("stream");
  await streamText(context, ANSWER.slice(260), 8, 8);
};

const goal: Script = async (context) => {
  context.update({ sessionUpdate: "session_info_update", _meta: { oxbit: { goal: { objective: "All auth tests pass", status: "active" }, loop: { iteration: 1, max: 10, interval: "5m" } } } });
  await streamText(context, "Goal set: **All auth tests pass**. I'll keep working until it is met.", 10, 10);
  context.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Continue toward the goal. Audit what is left before you stop." }, _meta: { oxbit: { continuation: true } } });
  await streamText(context, "All 8 auth tests pass. Marking the goal complete.", 10, 10);
};

const connection = () => new FakeConnection([fix, goal], {
  info: { provider: "openai", usingChatGPTPlan: true },
  commands: [
    { name: "goal", description: "Set a goal the agent works toward", input: { hint: "<objective>" } },
    { name: "loop", description: "Run a prompt on an interval", input: { hint: "[interval] <prompt>" } },
    { name: "compact", description: "Summarize the conversation to free context", input: { hint: "[focus]" } },
    { name: "undo", description: "Restore files to before the last turn" },
    { name: "redo", description: "Reapply the last undone turn" },
    { name: "skills", description: "List skills" },
    { name: "mcp", description: "Show MCP servers" },
    { name: "login", description: "Sign in with ChatGPT" },
  ],
  files: ["src/auth/login.ts", "src/auth/login.test.ts", "src/auth/session.ts", "src/app.tsx", "package.json", "README.md"],
  models: [{ id: "gpt-5.1", name: "GPT-5.1" }, { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" }, { id: "gpt-5.1-mini", name: "GPT-5.1 mini" }, { id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
});

async function frames(directory: string, columns: number) {
  stepped = true;
  gates.clear();
  const term = terminal(columns, 40);
  const fake = connection();
  const exited = run(fake, { cwd: CWD, debug: true, version: "0.9.0", ...term.streams });
  const frame = () => term.stdout.frame();
  const until = (text: string) => waitFor(() => frame().includes(text), frame, 5000);
  const save = (name: string) => writeFileSync(join(directory, `${columns}-${name}.txt`), `${frame()}\n`);
  await until("Ask anything");
  save("01-welcome");
  term.stdin.press(..."/");
  await until("/compact");
  save("02-slash-autocomplete");
  term.stdin.press(KEYS.ctrlU, ..."Fix the failing login test in @src/auth/lo");
  await until("src/auth/login.test.ts");
  save("03-file-autocomplete");
  term.stdin.press(KEYS.tab, KEYS.enter);
  await until("Search validatePassword");
  save("04-thinking-tools-plan");
  open("edit");
  await until("Run this command?");
  save("05-diff-and-permission");
  term.stdin.press(KEYS.down, KEYS.enter);
  await until("Normalize input");
  save("06-streaming-markdown");
  open("stream");
  await until("Ask anything");
  save("07-turn-done");
  term.stdin.press("\x10");
  await until("Choose a model");
  save("08-model-picker");
  term.stdin.press(KEYS.escape);
  await waitFor(() => !frame().includes("Choose a model"), frame);
  term.stdin.press(KEYS.shiftTab);
  term.stdin.press(..."/goal all auth tests pass", KEYS.enter);
  await until("Marking the goal complete");
  await until("Ask anything");
  save("09-goal-loop-accept-edits");
  term.stdin.press(..."/help", KEYS.enter);
  await until("Keys");
  save("10-help");
  term.stdin.press(KEYS.escape, KEYS.ctrlC, KEYS.ctrlC);
  await exited;
}

const args = process.argv.slice(2);
const target = args[args.indexOf("--frames") + 1];
if (args.includes("--frames") && target) {
  mkdirSync(target, { recursive: true });
  await frames(target, 100);
  await frames(target, 60);
  process.stdout.write(`Wrote frames to ${target}\n`);
} else {
  const result = await run(connection(), { cwd: process.cwd(), version: "demo", theme: args.includes("--light") ? "light" : "auto" });
  process.stdout.write(`Session ${result.sessionId ?? "none"} ended.\n`);
}
