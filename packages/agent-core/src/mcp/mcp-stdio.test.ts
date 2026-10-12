import { describe, expect, it, vi } from "vitest";
import { McpClient, MODERN_VERSION } from "./client.js";
import type { McpServerConfig } from "./config.js";
import type { JsonRpcMessage } from "./jsonrpc.js";
import type { SpawnOptions, StdioProcess } from "./stdio.js";

type Reply = (message: JsonRpcMessage) => void;
type Handler = (message: any, reply: Reply) => void;

/** A child process whose stdin goes to `handle` and whose stdout carries what `handle` replies. */
function fakeProcess(handle: Handler) {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => (exit = resolve));
  const reply: Reply = (message) => {
    queue.push(JSON.stringify(message));
    wake?.();
  };
  const finish = () => {
    ended = true;
    wake?.();
    exit();
  };
  const written: any[] = [];
  const options: SpawnOptions[] = [];
  const process: StdioProcess = {
    write: (text) => {
      expect(text.endsWith("\n")).toBe(true);
      const message = JSON.parse(text);
      written.push(message);
      handle(message, reply);
    },
    stdout: { async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } },
    end: vi.fn(finish),
    kill: vi.fn(finish),
    exited,
  };
  const spawn = (spawnOptions: SpawnOptions) => {
    options.push(spawnOptions);
    return process;
  };
  return { process, spawn, written, reply, finish, options };
}

const server: McpServerConfig = { name: "files", scope: "session", type: "stdio", command: "/bin/files", args: ["--stdio"], env: { TOKEN: "t" } };
const pages = [[{ name: "read", inputSchema: { type: "object" } }], [{ name: "write" }], [{ name: "delete" }]];
const ok = (id: unknown, result: unknown): JsonRpcMessage => ({ jsonrpc: "2.0", id: id as number, result });
const client = (spawn: any) => new McpClient({ server, cwd: "/work", fetch: vi.fn(), spawn, clientInfo: { name: "test", version: "1" } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function modern(listCalls: { count: number }): Handler {
  return (message, reply) => {
    if (message.method === "server/discover")
      reply(ok(message.id, { resultType: "complete", supportedVersions: [MODERN_VERSION], capabilities: { tools: { listChanged: true } }, instructions: "Use read first" }));
    if (message.method === "tools/list") {
      listCalls.count++;
      const page = Number(message.params.cursor ?? 0);
      reply(ok(message.id, { resultType: "complete", tools: pages[page], ...page + 1 < pages.length ? { nextCursor: String(page + 1) } : {} }));
    }
    if (message.method === "tools/call") reply(ok(message.id, { content: [{ type: "text", text: `ran ${message.params.name}` }] }));
  };
}

describe("MCP over stdio", () => {
  it("discovers a 2026-07-28 server, sends _meta on every request, pages tools/list and re-lists after list_changed", async () => {
    const calls = { count: 0 };
    const fake = fakeProcess(modern(calls));
    const mcp = client(fake.spawn);
    await mcp.connect();
    expect(fake.options[0]).toMatchObject({ command: "/bin/files", args: ["--stdio"], cwd: "/work",
      env: { TOKEN: "t", OXBIT_PROJECT_DIR: "/work", CLAUDE_PROJECT_DIR: "/work" } });
    expect([mcp.era, mcp.version, mcp.instructions]).toEqual(["modern", MODERN_VERSION, "Use read first"]);
    expect(fake.written.some((message) => message.method === "initialize")).toBe(false);
    const listen = fake.written.find((message) => message.method === "subscriptions/listen");
    expect(listen.params.notifications).toEqual({ toolsListChanged: true });
    expect((await mcp.listTools()).map((tool) => tool.name)).toEqual(["read", "write", "delete"]);
    expect(fake.written.filter((message) => message.method === "tools/list").map((message) => message.params.cursor)).toEqual([undefined, "1", "2"]);
    for (const message of fake.written.filter((item) => item.id !== undefined))
      expect(message.params._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } });
    await mcp.listTools();
    expect(calls.count).toBe(3);
    fake.reply({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { "io.modelcontextprotocol/subscriptionId": 999 } } });
    await tick();
    await mcp.listTools();
    expect(calls.count).toBe(3);
    fake.reply({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { "io.modelcontextprotocol/subscriptionId": listen.id } } });
    await tick();
    await mcp.listTools();
    expect(calls.count).toBe(6);
    expect(await mcp.callTool("read", { path: "a" })).toEqual({ content: [{ type: "text", text: "ran read" }] });
    await mcp.close();
    expect(fake.process.end).toHaveBeenCalled();
    expect(fake.process.kill).not.toHaveBeenCalled();
  });

  it("stops paging on a repeated cursor and expires the list after ttlMs", async () => {
    let now = 1000;
    let lists = 0;
    const fake = fakeProcess((message, reply) => {
      if (message.method === "server/discover") reply(ok(message.id, { supportedVersions: [MODERN_VERSION], capabilities: {} }));
      if (message.method === "tools/list") {
        lists++;
        reply(ok(message.id, { tools: [{ name: `t${lists}` }], nextCursor: "same", ttlMs: 500 }));
      }
    });
    const mcp = new McpClient({ server, cwd: "/work", fetch: vi.fn(), spawn: fake.spawn, clientInfo: { name: "test", version: "1" }, now: () => now });
    await mcp.connect();
    expect((await mcp.listTools()).map((tool) => tool.name)).toEqual(["t1", "t2"]);
    now += 400;
    await mcp.listTools();
    expect(lists).toBe(2);
    now += 200;
    await mcp.listTools();
    expect(lists).toBe(4);
    await mcp.close();
  });

  it("falls back to initialize for a legacy server, answers ping and handles list_changed without _meta", async () => {
    let lists = 0;
    const fake = fakeProcess((message, reply) => {
      if (message.method === "server/discover") reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      if (message.method === "initialize")
        reply(ok(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "old", version: "1" } }));
      if (message.method === "tools/list") reply(ok(message.id, { tools: [{ name: `tool${++lists}` }] }));
    });
    const mcp = client(fake.spawn);
    await mcp.connect();
    expect([mcp.era, mcp.version]).toEqual(["legacy", "2025-06-18"]);
    const initialize = fake.written.find((message) => message.method === "initialize");
    expect(initialize.params).toEqual({ protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(fake.written.map((message) => message.method)).toContain("notifications/initialized");
    expect((await mcp.listTools())[0].name).toBe("tool1");
    expect(fake.written.at(-1).params._meta).toBeUndefined();
    fake.reply({ jsonrpc: "2.0", id: "p1", method: "ping" });
    fake.reply({ jsonrpc: "2.0", id: "s1", method: "sampling/createMessage", params: {} });
    fake.reply({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await tick();
    expect(fake.written).toContainEqual({ jsonrpc: "2.0", id: "p1", result: {} });
    expect(fake.written.find((message) => message.id === "s1").error.code).toBe(-32601);
    expect((await mcp.listTools())[0].name).toBe("tool2");
    await mcp.close();
  });

  it("picks a legacy version from UnsupportedProtocolVersion data", async () => {
    const fake = fakeProcess((message, reply) => {
      if (message.method === "server/discover")
        reply({ jsonrpc: "2.0", id: message.id, error: { code: -32022, message: "Unsupported", data: { supported: ["2025-11-25"] } } });
      if (message.method === "initialize") reply(ok(message.id, { protocolVersion: "2025-11-25", capabilities: {} }));
    });
    const mcp = client(fake.spawn);
    await mcp.connect();
    expect([mcp.era, mcp.version]).toEqual(["legacy", "2025-11-25"]);
    await mcp.close();
  });

  it("sends notifications/cancelled on abort and reports an exit with the stderr tail", async () => {
    const fake = fakeProcess((message, reply) => {
      if (message.method === "server/discover") reply(ok(message.id, { supportedVersions: [MODERN_VERSION], capabilities: {} }));
    });
    const onClose = vi.fn();
    const mcp = new McpClient({ server, cwd: "/work", fetch: vi.fn(), spawn: fake.spawn, clientInfo: { name: "test", version: "1" }, onClose });
    await mcp.connect();
    const abort = new AbortController();
    const call = mcp.callTool("slow", {}, abort.signal);
    abort.abort();
    await expect(call).rejects.toThrow("tools/call was cancelled");
    const sent = fake.written.find((message) => message.method === "tools/call");
    expect(fake.written).toContainEqual({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: sent.id, reason: "Cancelled by the user" } });
    const pending = mcp.callTool("hang", {});
    fake.options[0].stderr("boom: missing config\n");
    fake.finish();
    await expect(pending).rejects.toThrow(/The MCP server exited\nboom: missing config/);
    expect(onClose).toHaveBeenCalled();
    expect(mcp.closed).toBe(true);
  });
});
