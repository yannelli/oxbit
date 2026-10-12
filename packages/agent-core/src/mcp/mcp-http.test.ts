import { describe, expect, it, vi } from "vitest";
import type { SessionView, ToolContext } from "../extensions.js";
import { McpClient, MODERN_VERSION } from "./client.js";
import type { McpServerConfig } from "./config.js";
import { McpTools } from "./tools.js";

interface Seen { url: string; method: string; headers: Headers; body: any; signal?: AbortSignal | null }
function fakeFetch(route: (request: Seen) => Response | Promise<Response>) {
  const requests: Seen[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const request = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined,
      signal: init.signal };
    requests.push(request);
    return route(request);
  });
  return { fetch, requests };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sse = (...messages: unknown[]) => new Response(messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const session = (mcpServers: unknown[]): SessionView => ({ id: "s1", cwd: "/work", model: "m", turns: [], meta: { mcpServers } });
const context = (): ToolContext => ({ root: "/work", sessionId: "s1", toolCallId: "c1", mode: "ask", filesystem: {} as never,
  signal: new AbortController().signal, request: vi.fn(), update: vi.fn() });
const remote = [{ type: "http", name: "remote", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] }];

describe("MCP over streamable HTTP", () => {
  it("speaks 2026-07-28 with Mcp-Method, Mcp-Name, Mcp-Param headers and SSE responses", async () => {
    const tools = [
      { name: "search", description: "Search docs", inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, q: { type: "string" } } } },
      { name: "bad", inputSchema: { type: "object", properties: { a: { type: "object", "x-mcp-header": "A" } } } },
    ];
    const { fetch, requests } = fakeFetch(({ body }) => {
      if (body.method === "server/discover") return json(result(body.id, { resultType: "complete", supportedVersions: [MODERN_VERSION], capabilities: { tools: {} } }));
      if (body.method === "tools/list") return sse({ jsonrpc: "2.0", method: "notifications/message", params: {} }, result(body.id, { tools }));
      return json(result(body.id, { content: [{ type: "text", text: "found" }], structuredContent: { hits: 1 } }));
    });
    const mcp = new McpTools({ fetch, read: async () => undefined });
    const list = await mcp.tools(session(remote));
    expect(list.map((tool) => [tool.spec.name, tool.kind])).toEqual([["mcp__remote__search", "execute"]]);
    expect(list[0].spec.parameters).toMatchObject({ type: "object" });
    expect(mcp.status("s1").servers[0]).toMatchObject({ state: "connected", version: MODERN_VERSION, tools: 1, excluded: 1, type: "http" });
    expect(await list[0].run({ region: "us-east", q: "hi" }, context())).toBe('found\n\n{\n  "hits": 1\n}');
    const call = requests.at(-1)!;
    expect(Object.fromEntries(call.headers)).toMatchObject({ accept: "application/json, text/event-stream", authorization: "Bearer x",
      "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/call", "mcp-name": "search", "mcp-param-region": "us-east" });
    expect(call.body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(MODERN_VERSION);
    expect(requests[0].headers.get("mcp-method")).toBe("server/discover");
    expect(requests.some((request) => request.headers.has("mcp-session-id"))).toBe(false);
    await mcp.closeAll();
  });

  it("falls back to an initialize session for a legacy server and re-initializes once after a 404", async () => {
    let session404 = false;
    let sessions = 0;
    const { fetch, requests } = fakeFetch(({ method, body, headers }) => {
      if (method === "DELETE") return new Response(null, { status: 200 });
      if (body.method === "server/discover") return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: Server not initialized" } }, 400);
      if (body.method === "initialize")
        return json(result(body.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} } }), 200, { "mcp-session-id": `sess-${++sessions}` });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (session404 && headers.get("mcp-session-id") === "sess-1") return new Response("Session not found", { status: 404 });
      if (body.method === "tools/list") return json(result(body.id, { tools: [{ name: "echo" }] }));
      return json(result(body.id, { content: [{ type: "text", text: `echo from ${headers.get("mcp-session-id")}` }] }));
    });
    const mcp = new McpTools({ fetch, read: async () => undefined });
    const [echo] = await mcp.tools(session(remote));
    const list = requests.find((request) => request.body?.method === "tools/list")!;
    expect(list.headers.get("mcp-session-id")).toBe("sess-1");
    expect(list.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(list.headers.has("mcp-method")).toBe(false);
    expect(list.body.params._meta).toBeUndefined();
    session404 = true;
    expect(await echo.run({}, context())).toBe("echo from sess-2");
    expect(requests.filter((request) => request.body?.method === "initialize")).toHaveLength(2);
    expect(requests.find((request) => request.method === "DELETE")?.headers.get("mcp-session-id")).toBe("sess-1");
    await mcp.close("s1");
    expect(requests.at(-1)).toMatchObject({ method: "DELETE" });
    expect(requests.at(-1)!.headers.get("mcp-session-id")).toBe("sess-2");
  });

  it("falls back to the legacy HTTP+SSE transport when POST initialize fails", async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const { fetch, requests } = fakeFetch((request) => {
      if (request.method === "GET") {
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          stream = controller;
          controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?sessionId=abc\n\n"));
        } });
        request.signal?.addEventListener("abort", () => stream.error(new Error("aborted")));
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (request.url === "https://mcp.example.com/mcp") return new Response("Not Found", { status: request.body.method === "initialize" ? 405 : 404 });
      const { body } = request;
      const reply = body.method === "initialize" ? result(body.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } })
        : body.method === "tools/list" ? result(body.id, { tools: [{ name: "old" }] }) : undefined;
      if (reply) stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(reply)}\n\n`));
      return new Response(null, { status: 202 });
    });
    const server: McpServerConfig = { name: "legacy", scope: "global", type: "http", url: "https://mcp.example.com/mcp", headers: {} };
    const mcp = new McpClient({ server, cwd: "/work", fetch, clientInfo: { name: "test", version: "1" } });
    await mcp.connect();
    expect([mcp.transport, mcp.era, mcp.version]).toEqual(["sse", "legacy", "2024-11-05"]);
    expect((await mcp.listTools()).map((tool) => tool.name)).toEqual(["old"]);
    expect(requests.filter((request) => request.url.startsWith("https://mcp.example.com/messages?sessionId=abc")).map((request) => request.body.method))
      .toEqual(["initialize", "notifications/initialized", "tools/list"]);
    await mcp.close();
  });

  it("reports 401 without trying a legacy fallback", async () => {
    const { fetch, requests } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
    const mcp = new McpTools({ fetch, read: async () => undefined });
    expect(await mcp.tools(session(remote))).toEqual([]);
    expect(requests).toHaveLength(1);
    const status = mcp.status("s1").servers[0];
    expect(status.state).toBe("failed");
    expect(status.error).toContain("The MCP server returned 401 Unauthorized. Oxbit Agent does not support MCP OAuth sign-in yet");
    const update = vi.fn();
    await mcp.commands()[0].run("", { session: session(remote), signal: new AbortController().signal, update, request: vi.fn(), replaceTurns: vi.fn(),
      compact: vi.fn() });
    expect(update.mock.calls[0][0].content.text).toMatch(/^MCP servers \(1\):\n- remote \(session, http\): failed: The MCP server returned 401/);
  });
});
