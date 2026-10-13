import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { claudeAgent, claudeStatus, planText } from "./claude.js";
import { main, type CliIO } from "./cli.js";
import { sink, tempDir } from "./testing.js";

/** Claude Agent's replies as seen 2026-10-12: no session/set_model, a `model` config option, -32000 when signed out. */
const FAKE_AGENT = `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let mode = "auto", model = "opus", loaded;
const config = () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model,
  options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] }];
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) => send({ id, result });
  if (method === "initialize") return reply({ protocolVersion: 1, agentInfo: { name: "fake-claude" }, authMethods: [] });
  if (method === "session/new") return reply({ sessionId: "new-1", modes: { currentModeId: mode, availableModes: [{ id: "default", name: "Manual" }, { id: "acceptEdits", name: "Accept edits" }] }, configOptions: config() });
  if (method === "session/list") return reply({ sessions: [{ sessionId: "old", cwd: params.cwd, updatedAt: "2026-10-01T00:00:00Z" }, { sessionId: "latest", cwd: params.cwd, updatedAt: "2026-10-12T00:00:00Z" }, { sessionId: "elsewhere", cwd: "/other", updatedAt: "2026-10-13T00:00:00Z" }] });
  if (method === "session/load") return loaded = params.sessionId, reply({});
  if (method === "session/set_mode") return mode = params.modeId, reply({});
  if (method === "session/set_config_option") return model = params.value, reply({ configOptions: config() });
  if (method === "session/prompt") {
    const text = params.prompt[0].text;
    if (text === "auth") return send({ id, error: { code: -32000, message: "Authentication required" } });
    send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: \`\${text} mode=\${mode} model=\${model} session=\${loaded ?? params.sessionId}\\n\` } } } });
    return reply({ stopReason: "end_turn" });
  }
  send({ id, error: { code: -32601, message: "Method not found" } });
});
`;

async function setup() {
  const home = await tempDir("oxa-claude-");
  const agentPath = join(home, "fake-claude-agent.mjs");
  await writeFile(agentPath, FAKE_AGENT);
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${join(home, "claude.log")}"\n`
    + `[ "$1 $2" = "auth status" ] && echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'\nexit 0\n`);
  await chmod(join(bin, "claude"), 0o755);
  const run = async (argv: string[], stdin: string | Readable = "") => {
    const stdout = sink();
    const stderr = sink();
    const io: CliIO = { stdin: typeof stdin === "string" ? Readable.from([stdin]) : stdin, stdout, stderr, cwd: home,
      env: { OXBIT_AGENT_HOME: join(home, "agent"), PATH: bin }, claudeAgent: { command: process.execPath, args: [agentPath] } };
    const code = await main(argv, io);
    return { code, stdout: stdout.text, stderr: stderr.text };
  };
  return { home, run, log: () => readFile(join(home, "claude.log"), "utf8"), settings: async () => JSON.parse(await readFile(join(home, "agent", "settings.json"), "utf8")) };
}

describe("Claude plan", () => {
  it("launches the pinned Claude Agent without API key variables", () => {
    const agent = claudeAgent({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_AUTH_TOKEN: "token", ANTHROPIC_BASE_URL: "https://proxy" });
    expect(agent).toEqual({ command: "npx", args: ["-y", expect.stringMatching(/^@agentclientprotocol\/claude-agent-acp@\d/)],
      env: { PATH: "/bin", ANTHROPIC_BASE_URL: "https://proxy" } });
  });

  it("prints a reply with the Oxbit mode mapped to Claude's mode and the model set through the config option", async () => {
    const t = await setup();
    const result = await t.run(["-p", "hi", "--provider", "claude", "--mode", "accept-edits", "--model", "sonnet"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hi mode=acceptEdits model=sonnet session=new-1");
  });

  it("continues the latest Claude Agent session in this directory", async () => {
    const t = await setup();
    const result = await t.run(["-p", "again", "--provider", "claude", "-c"]);
    expect(result.stdout).toContain("again mode=auto model=opus session=latest");
  });

  it("turns auth_required into the sign-in command", async () => {
    const t = await setup();
    const result = await t.run(["-p", "auth", "--provider", "claude"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("oxbit-agent login claude");
  });

  it("relays ACP to Claude Agent", async () => {
    const t = await setup();
    const stdin = new PassThrough();
    const running = t.run(["acp", "--provider", "claude"], stdin);
    stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    const result = await running;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).result.agentInfo.name).toBe("fake-claude");
  });

  it("lists Claude Agent's models", async () => {
    const t = await setup();
    const result = await t.run(["models", "--provider", "claude"]);
    expect(result.stdout).toBe("* opus    Opus\n  sonnet  Sonnet\n");
  });

  it("signs in and out through Claude Code and selects the Claude plan when settings name no provider", async () => {
    const t = await setup();
    expect((await t.run(["login", "claude"])).code).toBe(0);
    expect(await t.settings()).toMatchObject({ provider: "claude" });
    expect((await t.run(["logout", "claude"])).code).toBe(0);
    expect(await t.log()).toBe("auth login\nauth logout\n");
    expect((await t.run(["login"])).stdout).toMatch(/Claude plan +Claude Code sign-in +oxbit-agent login claude\n/);
  });

  it("reads the sign-in state from claude auth status", async () => {
    const t = await setup();
    expect(planText(await claudeStatus({ PATH: join(t.home, "bin") }))).toBe("signed in with Claude Max");
    expect(planText(await claudeStatus({ PATH: join(t.home, "missing") }))).toBe("Claude Code not installed");
  });
});
