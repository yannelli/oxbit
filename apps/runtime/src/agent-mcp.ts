import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { runtimeVersion } from "./version.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 16;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const SERVER_NAME = "oxbit_workspace";

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export const NATIVE_AGENT_TOOLS: readonly ToolDefinition[] = [
  {
    name: "oxbit_get_workspace",
    description: "Get the workspace, active editor, and current selection when an editor is connected.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oxbit_list_files",
    description: "List files in a workspace directory. Paths are workspace relative or absolute within the workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Directory path; defaults to the workspace root." } } },
  },
  {
    name: "oxbit_read_file",
    description: "Read a bounded range of a workspace file, including live unsaved editor content. Paths are workspace relative or absolute within the workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["path"] },
  },
  {
    name: "oxbit_get_diagnostics",
    description: "Get live editor diagnostics for a workspace file or the workspace. Requires a connected editor; headless runtimes have no diagnostics.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Optional workspace file path." } } },
  },
  {
    name: "oxbit_open_file",
    description: "Open a workspace file in the editor at an optional line.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } }, required: ["path"] },
  },
  {
    name: "oxbit_propose_edit",
    description: "Propose replacement content for a workspace file. The tool waits for engineer review and returns the decision.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "oxbit_update_plan",
    description: "Publish the current task plan with at most 50 entries.",
    inputSchema: { type: "object", properties: { entries: { type: "array", maxItems: 50, items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, priority: { type: "string" } }, required: ["content", "status"] } } }, required: ["entries"] },
  },
] as const;

export type AgentMcpServer =
  | { name: typeof SERVER_NAME; type: "http"; url: string; headers: { name: string; value: string }[] }
  | { name: typeof SERVER_NAME; command: string; args: string[]; env: { name: string; value: string }[] };

const STDIO_PROXY = String.raw`
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
let closing = false;
const maxBytes = 1024 * 1024;
const send = (message) => {
  if (!closing) process.stdout.write(JSON.stringify(message) + '\n');
};
const fail = (id, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message } });
input.on('line', (line) => {
  if (Buffer.byteLength(line) > maxBytes) return fail(null, 'MCP input line is too large');
  let message;
  try { message = JSON.parse(line); }
  catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
  const hasId = message !== null && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'id');
  if (pending.size >= 16) {
    if (hasId) fail(message.id, 'MCP proxy is busy');
    return;
  }
  const controller = new AbortController();
  pending.add(controller);
  void (async () => {
    try {
      const response = await fetch(process.env.OXBIT_MCP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + process.env.OXBIT_MCP_TOKEN },
        body: line,
        signal: controller.signal,
      });
      if (!hasId) { await response.body?.cancel(); return; }
      const length = Number(response.headers.get('content-length'));
      if (length > maxBytes) throw new Error('MCP response is too large');
      const reader = response.body?.getReader();
      if (!reader) throw new Error(response.ok ? 'MCP proxy returned an empty response' : 'MCP proxy HTTP ' + response.status);
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('MCP response is too large'); }
        chunks.push(value);
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch { throw new Error(response.ok ? 'MCP proxy returned invalid JSON' : 'MCP proxy HTTP ' + response.status); }
      if (result?.jsonrpc !== '2.0' || result.id !== message.id || (!result.result && !result.error)) throw new Error(response.ok ? 'MCP proxy returned an invalid response' : 'MCP proxy HTTP ' + response.status);
      if (!response.ok && !result.error) throw new Error('MCP proxy HTTP ' + response.status);
      send(result);
    } catch (error) {
      if (hasId && !closing) fail(message.id, error instanceof Error ? error.message : String(error));
    } finally {
      pending.delete(controller);
    }
  })();
});
input.on('close', () => {
  closing = true;
  for (const controller of pending) controller.abort();
});`;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateArguments(name: string, args: Record<string, unknown>): string | undefined {
  if (!NATIVE_AGENT_TOOLS.some((tool) => tool.name === name)) return "Unknown tool";
  const keys = Object.keys(args);
  const allowed: Record<string, string[]> = {
    oxbit_get_workspace: [], oxbit_list_files: ["path"], oxbit_read_file: ["path", "line", "limit"],
    oxbit_get_diagnostics: ["path"], oxbit_open_file: ["path", "line"],
    oxbit_propose_edit: ["path", "content"], oxbit_update_plan: ["entries"],
  };
  if (keys.some((key) => !allowed[name].includes(key))) return "Unknown tool argument";
  if (["oxbit_read_file", "oxbit_open_file", "oxbit_propose_edit"].includes(name) && (typeof args.path !== "string" || !args.path)) return "path must be a nonempty string";
  if (["oxbit_list_files", "oxbit_get_diagnostics"].includes(name) && args.path !== undefined && typeof args.path !== "string") return "path must be a string";
  if (args.line !== undefined && (!Number.isSafeInteger(args.line) || (args.line as number) < 1)) return "line must be a positive integer";
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1)) return "limit must be a positive integer";
  if (name === "oxbit_propose_edit" && typeof args.content !== "string") return "content must be a string";
  if (name === "oxbit_update_plan" && (!Array.isArray(args.entries) || args.entries.length > 50 || args.entries.some((entry) => !object(entry) || typeof entry.content !== "string" || !["pending", "in_progress", "completed"].includes(String(entry.status)) || (entry.priority !== undefined && typeof entry.priority !== "string")))) return "entries must contain plan content and status";
  return undefined;
}

function reply(response: ServerResponse, status: number, body?: unknown): void {
  response.statusCode = status;
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export class AgentMCP {
  private listener?: Server;
  private starting?: Promise<void>;
  private url?: string;
  private tokens = new Map<string, string>();
  private activeRequests = 0;

  constructor(private handler: (connectionId: string, name: string, args: Record<string, unknown>) => Promise<unknown>) {}

  async server(connectionId: string, httpSupported: boolean): Promise<AgentMcpServer> {
    if (!this.listener && !this.starting) this.starting = this.startListener();
    if (this.starting) await this.starting;
    let token = this.tokens.get(connectionId);
    if (!token) {
      token = randomBytes(32).toString("hex");
      this.tokens.set(connectionId, token);
    }
    if (httpSupported) return { name: SERVER_NAME, type: "http", url: this.url!, headers: [{ name: "Authorization", value: `Bearer ${token}` }] };
    return { name: SERVER_NAME, command: process.execPath, args: ["-e", STDIO_PROXY], env: [
      { name: "OXBIT_MCP_URL", value: this.url! }, { name: "OXBIT_MCP_TOKEN", value: token },
      ...process.versions.electron ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }] : [],
    ] };
  }

  private async startListener(): Promise<void> {
    const listener = createServer((request, response) => { void this.handle(request, response); });
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => { listener.off("error", reject); resolve(); });
      });
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("MCP listener has no TCP address");
      this.listener = listener;
      this.url = "http://127.0.0.1:" + address.port + "/mcp";
    } catch (error) {
      listener.close();
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  revoke(connectionId: string): void { this.tokens.delete(connectionId); }

  async close(): Promise<void> {
    this.tokens.clear();
    if (this.starting) await this.starting.catch(() => {});
    const listener = this.listener;
    this.listener = undefined;
    this.url = undefined;
    if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = this.listener?.address();
    if (!address || typeof address === "string") return reply(response, 503);
    const origin = `http://127.0.0.1:${address.port}`;
    if (request.headers.host !== `127.0.0.1:${address.port}` || (request.headers.origin && request.headers.origin !== origin)) return reply(response, 403);
    if (request.url !== "/mcp") return reply(response, 404);
    if (request.method !== "POST") return reply(response, 405);
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const connectionId = token && [...this.tokens].find(([, candidate]) => candidate === token)?.[0];
    if (!connectionId) return reply(response, 401);
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) return reply(response, 429);
    const contentLength = Number(request.headers["content-length"]);
    if (contentLength > MAX_REQUEST_BYTES) return reply(response, 413);
    this.activeRequests++;
    try {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_REQUEST_BYTES) return reply(response, 413);
        chunks.push(chunk);
      }
      let message: unknown;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return reply(response, 400, rpcError(null, -32700, "Invalid JSON")); }
      if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")) return reply(response, 400, rpcError(object(message) ? message.id : null, -32600, "Invalid request"));
      const version = request.headers["mcp-protocol-version"];
      if (version && !PROTOCOL_VERSIONS.includes(version as typeof PROTOCOL_VERSIONS[number])) return reply(response, 400, rpcError(message.id, -32600, "Unsupported MCP protocol version"));
      if (message.id === undefined) return reply(response, 202);
      const id = message.id;
      if (message.method === "initialize") {
        const requested = object(message.params) && typeof message.params.protocolVersion === "string" ? message.params.protocolVersion : undefined;
        return reply(response, 200, { jsonrpc: "2.0", id, result: { protocolVersion: requested && PROTOCOL_VERSIONS.includes(requested as typeof PROTOCOL_VERSIONS[number]) ? requested : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "oxbit-workspace", version: runtimeVersion() } } });
      }
      if (message.method === "ping") return reply(response, 200, { jsonrpc: "2.0", id, result: {} });
      if (message.method === "tools/list") return reply(response, 200, { jsonrpc: "2.0", id, result: { tools: NATIVE_AGENT_TOOLS } });
      if (message.method !== "tools/call") return reply(response, 200, rpcError(id, -32601, "Method not found"));
      const params = message.params;
      if (!object(params) || typeof params.name !== "string" || !object(params.arguments ?? {})) return reply(response, 200, rpcError(id, -32602, "Invalid tool call"));
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const invalid = validateArguments(params.name, args);
      if (invalid) return reply(response, 200, { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: invalid }] } });
      try {
        const value = await this.handler(connectionId, params.name, args);
        if (this.tokens.get(connectionId) !== token) return reply(response, 401);
        const structuredContent = object(value) ? value : { value: value ?? null };
        return reply(response, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value ?? null) }], structuredContent } });
      } catch (error) {
        if (this.tokens.get(connectionId) !== token) return reply(response, 401);
        return reply(response, 200, { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } });
      }
    } catch (error) {
      if (!response.writableEnded) reply(response, 400, rpcError(null, -32600, error instanceof Error ? error.message : String(error)));
    } finally {
      this.activeRequests--;
    }
  }
}
