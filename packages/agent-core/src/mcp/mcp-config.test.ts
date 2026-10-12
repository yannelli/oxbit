import { describe, expect, it, vi } from "vitest";
import type { SessionView } from "../extensions.js";
import { mergeServers, parseAcpServers, parseMcpJson } from "./config.js";
import { headerParams, paramHeaders, renderResult, toolName, toolSchema } from "./render.js";
import { McpTools } from "./tools.js";
import { headerValue } from "./jsonrpc.js";

describe("MCP config", () => {
  it("parses Claude .mcp.json entries with variable expansion and the url-without-type error", () => {
    const text = JSON.stringify({ mcpServers: {
      local: { command: "${BIN:-/usr/bin}/server", args: ["--root", "${HOME}"], env: { TOKEN: "${TOKEN}" } },
      remote: { type: "http", url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${OPENAI_API_KEY}", "X-Team": "${TEAM}" } },
      events: { type: "sse", url: "https://events.example.com/sse" },
      streamable: { type: "streamable-http", url: "https://s.example.com/mcp" },
      untyped: { url: "https://x.example.com" },
      socket: { type: "ws", url: "wss://x.example.com" },
      off: { command: "/bin/off", disabled: true },
    } });
    const { servers, warnings } = parseMcpJson(text, "project", { HOME: "/home/me", TOKEN: "t", HOST: "mcp.example.com", OPENAI_API_KEY: "sk-secret" });
    expect(servers).toEqual([
      { name: "local", scope: "project", type: "stdio", command: "/usr/bin/server", args: ["--root", "/home/me"], env: { TOKEN: "t" } },
      { name: "remote", scope: "project", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ", "X-Team": "${TEAM}" } },
      { name: "events", scope: "project", type: "sse", url: "https://events.example.com/sse", headers: {} },
      { name: "streamable", scope: "project", type: "http", url: "https://s.example.com/mcp", headers: {} },
    ]);
    expect(warnings).toEqual([
      'MCP server "remote" references ${TEAM}, which is not set',
      'MCP server "untyped" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry',
      'MCP server "socket" uses the "ws" transport, which Oxbit Agent does not support',
    ]);
    expect(parseMcpJson("{", "global").warnings[0]).toMatch(/^\.mcp\.json is not valid JSON/);
  });

  it("parses ACP session/new servers and merges by name with later scopes winning", () => {
    const acp = parseAcpServers([
      { name: "files", command: "/bin/files", args: ["-v"], env: [{ name: "A", value: "1" }] },
      { type: "http", name: "remote", url: "https://r.example.com", headers: [{ name: "Authorization", value: "Bearer t" }] },
      { name: "", command: "/bin/x" },
    ]);
    expect(acp.servers).toEqual([
      { name: "files", scope: "session", type: "stdio", command: "/bin/files", args: ["-v"], env: { A: "1" } },
      { name: "remote", scope: "session", type: "http", url: "https://r.example.com", headers: { Authorization: "Bearer t" } },
    ]);
    expect(acp.warnings).toEqual(["An MCP server from the client has no name"]);
    const global = parseMcpJson(JSON.stringify({ mcpServers: { files: { command: "/global" }, other: { command: "/other" } } }), "global").servers;
    expect(mergeServers(global, acp.servers).map((server) => [server.name, server.scope])).toEqual([["files", "session"], ["other", "global"], ["remote", "session"]]);
  });
});

describe("MCP rendering", () => {
  it("builds mcp__server__tool names within 64 characters and keeps them unique", () => {
    const taken = new Set<string>();
    expect(toolName("git hub", "create.issue", taken)).toBe("mcp__git_hub__create_issue");
    expect(toolName("git.hub", "create issue", taken)).toMatch(/^mcp__git_hub__create_issue_[0-9a-f]{8}$/);
    const long = toolName("server", "x".repeat(80), taken);
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/);
    expect(long).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("reads x-mcp-header annotations and rejects invalid ones", () => {
    const schema = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" },
      options: { type: "object", properties: { dry: { type: "boolean", "x-mcp-header": "Dry-Run" } } } } };
    const params = headerParams(schema)!;
    expect(params).toEqual([{ path: ["region"], header: "Region" }, { path: ["options", "dry"], header: "Dry-Run" }]);
    expect(paramHeaders(params, { region: "Zürich", options: { dry: true } })).toEqual({ "Mcp-Param-Region": headerValue("Zürich"), "Mcp-Param-Dry-Run": "true" });
    expect(headerValue("Zürich")).toBe(`=?base64?${btoa(String.fromCharCode(...new TextEncoder().encode("Zürich")))}?=`);
    expect(headerParams({ properties: { a: { type: "string", "x-mcp-header": "Bad Name" } } })).toBeUndefined();
    expect(headerParams({ properties: { a: { type: "string", "x-mcp-header": "X" }, b: { type: "number", "x-mcp-header": "x" } } })).toBeUndefined();
    expect(toolSchema(undefined)).toEqual({ type: "object", properties: {} });
  });

  it("renders content blocks, structured content and errors as text", () => {
    expect(renderResult({ content: [
      { type: "text", text: "hello" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "resource_link", uri: "file:///a.txt", name: "a.txt" },
      { type: "resource", resource: { uri: "file:///b.txt", text: "bee" } },
    ] })).toBe("hello\n\n[image image/png, 3 bytes]\n\n[resource a.txt file:///a.txt]\n\nfile:///b.txt:\nbee");
    expect(renderResult({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } })).toBe('{"a":1}');
    expect(renderResult({ content: [] })).toBe("(no output)");
    expect(renderResult({ content: [{ type: "text", text: "x".repeat(100010) }] })).toMatch(/\n\[Output cut at 100000 characters\]$/);
    expect(() => renderResult({ isError: true, content: [{ type: "text", text: "No such file" }] })).toThrow("No such file");
  });
});

describe("McpTools lifecycle", () => {
  const view = (id: string, cwd = "/work"): SessionView => ({ id, cwd, model: "m", turns: [], meta: {} });
  const files = (project: string) => vi.fn(async (path: string) => path === "/work/.mcp.json" ? project : path === "/home/.oxbit/mcp.json"
    ? JSON.stringify({ mcpServers: { shared: { type: "http", url: "https://global.example.com/mcp" } } }) : undefined);

  it("loads the global config, the project config only when trusted, and closes on SessionEnd", async () => {
    const project = JSON.stringify({ mcpServers: { shared: { type: "http", url: "https://project.example.com/mcp" } } });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null);
      const body = JSON.parse(String(init?.body));
      if (body.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: body.id, result: { supportedVersions: ["2026-07-28"], capabilities: {} } });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: url.includes("project") ? "project_tool" : "global_tool" }] } });
    });
    const trust = vi.fn(async (cwd: string) => cwd === "/work");
    const read = files(project);
    const mcp = new McpTools({ fetch, read, globalConfig: "/home/.oxbit/mcp.json", trustProject: trust, idleMs: 0 });
    expect((await mcp.tools(view("a"))).map((tool) => tool.spec.name)).toEqual(["mcp__shared__project_tool"]);
    expect((await mcp.tools(view("b", "/other"))).map((tool) => tool.spec.name)).toEqual(["mcp__shared__global_tool"]);
    expect(mcp.status("b").warnings).toEqual([]);
    expect(mcp.status("a").servers[0]).toMatchObject({ scope: "project", state: "connected" });
    const next = { run: vi.fn(async () => ({ systemMessage: "bye" })) };
    const hooks = mcp.hooks(next);
    expect(await hooks.run("SessionEnd", { session_id: "a", reason: "other" }, new AbortController().signal)).toEqual({ systemMessage: "bye" });
    expect(mcp.status("a").servers).toEqual([]);
    expect(mcp.status("b").servers).toHaveLength(1);
    await mcp.closeAll();
    expect(mcp.status("b").servers).toEqual([]);
  });

  it("names an untrusted project's servers in the warnings without loading them", async () => {
    const project = JSON.stringify({ mcpServers: { local: { command: "./server" }, remote: { type: "http", url: "https://project.example.com/mcp" } } });
    const fetch = vi.fn(async () => Response.json({}));
    const mcp = new McpTools({ fetch, read: files(project), trustProject: () => false, trustHint: "Trust it in settings.", idleMs: 0 });
    expect(await mcp.tools(view("a"))).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(mcp.status("a").warnings).toEqual(["/work/.mcp.json is not trusted, so its servers are off: local, remote. Trust it in settings."]);
  });

  it("reconnects when the server list changes and leaves out skipped servers", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null);
      const body = JSON.parse(String(init?.body));
      if (body.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: body.id, result: { supportedVersions: ["2026-07-28"], capabilities: {} } });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: new URL(url).hostname.split(".")[0] }] } });
    });
    const servers: Record<string, object> = { one: { type: "http", url: "https://one.example.com/mcp" } };
    const skipped = new Set<string>();
    const mcp = new McpTools({ fetch, read: async () => JSON.stringify({ mcpServers: servers }), globalConfig: "/home/.oxbit/mcp.json", idleMs: 0,
      skip: (server) => skipped.has(server.name) });
    const names = async () => (await mcp.tools(view("a"))).map((tool) => tool.spec.name);
    expect(await names()).toEqual(["mcp__one__one"]);
    const discovers = () => fetch.mock.calls.filter(([, init]) => String(init?.body).includes("server/discover")).length;
    await names();
    expect(discovers()).toBe(1);
    servers.two = { type: "http", url: "https://two.example.com/mcp" };
    expect(await names()).toEqual(["mcp__one__one", "mcp__two__two"]);
    skipped.add("one");
    expect(await names()).toEqual(["mcp__two__two"]);
    expect(mcp.status("a").servers.map((server) => server.name)).toEqual(["two"]);
    expect(mcp.report("a")).toBe("MCP servers (1):\n- two (global, http, 2026-07-28): connected, 1 tools");
    await mcp.closeAll();
  });

  it("closes idle sessions and connects again on the next step", async () => {
    vi.useFakeTimers();
    try {
      let connects = 0;
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "server/discover") connects++;
        if (body.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: body.id, result: { supportedVersions: ["2026-07-28"], capabilities: {} } });
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t" }] } });
      });
      const mcp = new McpTools({ fetch, read: files(""), globalConfig: "/home/.oxbit/mcp.json", idleMs: 1000 });
      await mcp.tools(view("a"));
      expect(mcp.status("a").servers[0].state).toBe("connected");
      await vi.advanceTimersByTimeAsync(1500);
      expect(mcp.status("a").servers[0].state).toBe("idle");
      await mcp.tools(view("a"));
      expect(connects).toBe(2);
      await mcp.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});
