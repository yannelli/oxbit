import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMCP, NATIVE_AGENT_TOOLS } from "../src/agent-mcp.js";

type HttpServer = Extract<Awaited<ReturnType<AgentMCP["server"]>>, { type: "http" }>;

describe("native agent MCP transport", () => {
  const servers: AgentMCP[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  function setup(handler = async (_connectionId: string, _name: string, args: Record<string, unknown>): Promise<unknown> => args) {
    const server = new AgentMCP(handler);
    servers.push(server);
    return server;
  }

  async function post(server: HttpServer, message: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: server.headers[0].value,
        ...headers,
      },
      body: JSON.stringify(message),
    });
    const body = await response.text();
    return { status: response.status, body: body ? JSON.parse(body) : undefined };
  }

  it("negotiates MCP, lists native tools, and calls through the connection handler", async () => {
    const calls: unknown[] = [];
    const server = setup(async (connectionId, name, args) => {
      calls.push({ connectionId, name, args });
      return { files: ["src/index.ts"] };
    });
    const descriptor = await server.server("agent-1", true);
    if (descriptor.type !== "http") throw new Error("Expected HTTP MCP descriptor");
    const initialized = await post(descriptor, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(initialized.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "oxbit-workspace" } });
    expect((await post(descriptor, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const listed = await post(descriptor, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(NATIVE_AGENT_TOOLS.map((tool) => tool.name));
    const called = await post(descriptor, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "oxbit_list_files", arguments: { path: "src" } } });
    expect(called.body.result).toMatchObject({ content: [{ type: "text", text: '{"files":["src/index.ts"]}' }], structuredContent: { files: ["src/index.ts"] } });
    expect(calls).toEqual([{ connectionId: "agent-1", name: "oxbit_list_files", args: { path: "src" } }]);
    expect((await post(descriptor, { jsonrpc: "2.0", id: 4, method: "ping" })).body.result).toEqual({});
  });

  it("isolates tokens and rejects unexpected hosts, origins, versions, and oversized requests", async () => {
    const server = setup();
    const descriptor = await server.server("agent-1", true);
    if (descriptor.type !== "http") throw new Error("Expected HTTP MCP descriptor");
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(descriptor, ping, { authorization: "Bearer invalid" })).status).toBe(401);
    expect((await post(descriptor, ping, { origin: "https://example.com" })).status).toBe(403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(descriptor.url, { method: "POST", headers: { host: "example.com", authorization: descriptor.headers[0].value } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end(JSON.stringify(ping));
    });
    expect(hostStatus).toBe(403);
    expect((await post(descriptor, ping, { "mcp-protocol-version": "2030-01-01" })).status).toBe(400);
    expect((await post(descriptor, { ...ping, padding: "x".repeat(1024 * 1024) })).status).toBe(413);
    server.revoke("agent-1");
    expect((await post(descriptor, ping)).status).toBe(401);
  });

  it("returns tool failures as MCP results and bounds invalid arguments", async () => {
    const server = setup(async () => { throw new Error("workspace unavailable"); });
    const descriptor = await server.server("agent-1", true);
    if (descriptor.type !== "http") throw new Error("Expected HTTP MCP descriptor");
    const call = (name: string, args: unknown) => post(descriptor, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    expect((await call("oxbit_get_workspace", {})).body.result).toMatchObject({ isError: true, content: [{ text: "workspace unavailable" }] });
    expect((await call("oxbit_read_file", { path: "src", line: 0 })).body.result).toMatchObject({ isError: true, content: [{ text: "line must be a positive integer" }] });
    expect((await call("oxbit_read_file", [])).body.error.code).toBe(-32602);
    expect((await post(descriptor, { jsonrpc: "2.0", id: 2, method: "resources/list" })).body.error.code).toBe(-32601);
  });

  it("serves the same tools through the stdio fallback", async () => {
    const server = setup(async (connectionId) => ({ connectionId }));
    const descriptor = await server.server("agent-1", false);
    if ("type" in descriptor) throw new Error("Expected stdio MCP descriptor");
    const child = spawn(descriptor.command, descriptor.args, {
      env: { ...process.env, ...Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value])) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const response = new Promise<any>((resolve, reject) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]));
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error("MCP proxy exited before responding")));
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "oxbit_get_workspace", arguments: {} } }) + "\n");
      expect((await response).result.structuredContent).toEqual({ connectionId: "agent-1" });
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });

  it("keeps stdio requests responsive while a reviewed edit waits", async () => {
    let finishReview!: (value: unknown) => void;
    const review = new Promise<unknown>((resolve) => { finishReview = resolve; });
    const server = setup(async (_connectionId, name) => name === "oxbit_propose_edit" ? review : {});
    const descriptor = await server.server("agent-1", false);
    if ("type" in descriptor) throw new Error("Expected stdio MCP descriptor");
    const child = spawn(descriptor.command, descriptor.args, {
      env: { ...process.env, ...Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value])) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = new Map<number, any>();
    const waiters = new Map<number, (value: any) => void>();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const response = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        responses.set(response.id, response);
        waiters.get(response.id)?.(response);
        waiters.delete(response.id);
      }
    });
    const next = (id: number) => new Promise<any>((resolve) => {
      if (responses.has(id)) resolve(responses.get(id));
      else waiters.set(id, resolve);
    });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "oxbit_propose_edit", arguments: { path: "src/index.ts", content: "new" } } }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
      expect((await next(2)).result).toEqual({});
      expect(responses.has(1)).toBe(false);
      finishReview({ approved: true });
      expect((await next(1)).result.structuredContent).toEqual({ approved: true });
    } finally {
      finishReview({ approved: false });
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });
});
