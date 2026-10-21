import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs";

const repo = path.resolve(import.meta.dirname, "../..");
const server = path.join(repo, "scripts/agent/mcp/server.mjs");

type Message = { id?: number; result?: any; error?: any };

class Client {
  next = 1;
  pending = new Map<number, (message: Message) => void>();
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Message;
      if (typeof message.id === "number") this.pending.get(message.id)?.(message);
    });
  }
  request(method: string, params?: object): Promise<Message> {
    const id = this.next++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  notify(method: string) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }
  async call(name: string, args: object = {}) {
    const response = await this.request("tools/call", { name, arguments: args });
    expect(response.error).toBeUndefined();
    return response.result;
  }
}

function writeStub(dir: string, name: string, body: string) {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

let temp: string;
let client: Client;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "oxbit-mcp-server-"));
  const bin = path.join(temp, "bin");
  const ledgers = path.join(temp, "ledgers");
  const roots = path.join(temp, "worktrees");
  fs.mkdirSync(bin);
  fs.cpSync(path.join(repo, "docs/agents/ledgers"), ledgers, { recursive: true });
  const work = path.join(roots, "abc123", "lost-work");
  fs.mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start"]);
  fs.writeFileSync(path.join(work, "draft.txt"), "unsaved\n");
  writeStub(bin, "launchctl", 'echo Background');
  writeStub(bin, "gh", [
    'case "$1 $2" in',
    `  "pr list") echo '[{"number":90,"title":"Remote access","headRefName":"feat/remote-access","url":"u","updatedAt":"2026-10-19T00:00:00Z"}]' ;;`,
    '  api*) printf "47\\t2\\n" ;;',
    "  *) exit 1 ;;",
    "esac",
  ].join("\n"));
  const child = spawn("node", [server], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OXBIT_WORKTREE_ROOTS: roots, OXBIT_LEDGER_DIR: ledgers, OXBIT_LOCAL_LEDGER_DIR: path.join(temp, "local-ledgers") },
  });
  client = new Client(child);
});

afterAll(() => {
  client?.child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("MCP server over stdio", () => {
  it("initializes, lists tools and calls each tool", async () => {
    const init = await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "vitest", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "oxbit-agent-tools" } });
    client.notify("notifications/initialized");
    expect((await client.request("ping")).result).toEqual({});

    const listed = await client.request("tools/list");
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(["checks_for_paths", "docs_for_paths", "unpushed_work", "ledger_list", "ledger_add", "ledger_update", "doctor", "stale_work"]);
    for (const tool of listed.result.tools) expect(tool.inputSchema.type).toBe("object");

    const checks = await client.call("checks_for_paths", { paths: ["packages/features/themes/src/manager.tsx", "apps/desktop/src-tauri/src/main.rs"] });
    const commands = checks.structuredContent.focused.map((entry: { command: string }) => entry.command);
    expect(commands).toEqual(expect.arrayContaining(["node scripts/theme-coverage.mjs --check", "bun run desktop:check", "bun run lint"]));
    expect(JSON.parse(checks.content[0].text)).toEqual(checks.structuredContent);

    const docs = await client.call("docs_for_paths", { paths: ["docs/ios-runtime-parity.md"] });
    expect(docs.structuredContent.results[0].docs[0]).toMatchObject({ doc: "docs/ios-runtime-parity.md", via: "index" });

    const unpushed = await client.call("unpushed_work");
    expect(unpushed.structuredContent.roots).toEqual([path.join(temp, "worktrees")]);
    const lost = unpushed.structuredContent.atRisk.find((state: { path: string }) => state.path.endsWith("lost-work"));
    expect(lost).toMatchObject({ dirty: 1 });

    const asked = await client.call("ledger_add", { ledger: "open-questions", item: "spawned question", source: "PR #1" });
    expect(asked.structuredContent).toMatchObject({ location: "local", row: { id: "Q-001" } });
    const open = await client.call("ledger_list", { ledger: "open-questions", status: "open" });
    expect(open.structuredContent.ledgers[0].rows).toEqual([expect.objectContaining({ id: "Q-001", location: "local" })]);
    const added = await client.call("ledger_add", { ledger: "flaky-tests", item: "spawned test flake", source: "run 1" });
    expect(added.structuredContent.row).toMatchObject({ id: "T-003", status: "open" });
    const updated = await client.call("ledger_update", { ledger: "flaky-tests", id: "T-003", status: "done" });
    expect(updated.structuredContent.row.status).toBe("done");
    expect(fs.readFileSync(path.join(repo, "docs/agents/ledgers/flaky-tests.md"), "utf8")).not.toContain("spawned test flake");

    const doctor = await client.call("doctor");
    expect(doctor.structuredContent.node).toMatchObject({ expected: fs.readFileSync(path.join(repo, ".node-version"), "utf8").trim() });
    expect(doctor.structuredContent.bun.source).toBe("package.json packageManager");
    if (process.platform === "darwin") expect(doctor.structuredContent.session).toMatchObject({ manager: "Background", background: true });

    const stale = await client.call("stale_work");
    expect(stale.structuredContent).toMatchObject({ available: true, drafts: [{ number: 90, behindMain: 47, aheadOfMain: 2 }] });
  });

  it("reports protocol errors and tool errors", async () => {
    expect((await client.request("resources/list")).error.code).toBe(-32601);
    expect((await client.request("tools/call", { name: "nope", arguments: {} })).error.code).toBe(-32602);
    const failed = await client.request("tools/call", { name: "ledger_add", arguments: { ledger: "nope", item: "x", source: "y" } });
    expect(failed.result).toMatchObject({ isError: true });
    expect(failed.result.content[0].text).toContain('Unknown ledger "nope"');
  });

  it("serves 2026-07-28 requests without initialize", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
    const discover = await client.request("server/discover", { _meta: meta });
    expect(discover.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]) });
    const listed = await client.request("tools/list", { _meta: meta });
    expect(listed.result.resultType).toBe("complete");
    const old = await client.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
    expect(old.error).toMatchObject({ code: -32022, data: { requested: "1900-01-01" } });
  });

  it("exits when stdin closes", async () => {
    const exited = new Promise<number | null>((resolve) => client.child.on("exit", resolve));
    client.child.stdin.end();
    expect(await exited).toBe(0);
  });
});
