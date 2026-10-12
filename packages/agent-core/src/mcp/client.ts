import type { Fetch } from "../providers/http.js";
import type { McpServerConfig } from "./config.js";
import { HttpTransport, SseTransport } from "./http.js";
import { MODERN_ERROR_CODES, McpError, type JsonRpcMessage, type Transport } from "./jsonrpc.js";
import { StdioTransport, type Spawn } from "./stdio.js";

/** The current MCP revision (modelcontextprotocol.io/specification/2026-07-28, fetched 2026-10-11) and the handshake-based ones before it. */
export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META = "io.modelcontextprotocol/";
const RETRY_STATUSES = new Set([400, 404, 405]);

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, any>;
  annotations?: Record<string, any>;
}
export interface McpClientOptions {
  server: McpServerConfig;
  cwd: string;
  fetch: Fetch;
  spawn?: Spawn;
  clientInfo: { name: string; version: string };
  /** Defaults: connect 30 s, requests 300 s, the stdio discover probe 5 s. */
  connectTimeout?: number;
  requestTimeout?: number;
  probeTimeout?: number;
  now?(): number;
  onClose?(error: Error): void;
}
type Probe = { result: any } | { supported: string[] } | { legacy: true };

/** One MCP server connection. Speaks 2026-07-28 per-request metadata, or falls back to the `initialize` handshake for older servers. */
export class McpClient {
  era?: "modern" | "legacy";
  version?: string;
  capabilities: Record<string, any> = {};
  instructions?: string;
  transport?: "stdio" | "http" | "sse";
  closed = false;
  private channel?: Transport;
  private nextId = 1;
  private cache?: { list: McpToolInfo[]; expires: number };
  private generation = 0;
  private subscription?: { id: number; abort: AbortController };
  constructor(private options: McpClientOptions) {}
  get stderr() {
    return this.channel instanceof StdioTransport ? this.channel.stderr : "";
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  async connect() {
    const timeout = this.options.connectTimeout ?? 30000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.open(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new McpError(`Connecting timed out after ${Math.round(timeout / 1000)} s`)), timeout);
      })]);
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private attach<T extends Transport>(transport: T) {
    this.channel = transport;
    transport.onmessage = (message) => this.receive(transport, message);
    transport.onclose = (error) => {
      if (this.channel !== transport) return;
      this.closed = true;
      this.options.onClose?.(error);
    };
    return transport;
  }
  private async open() {
    const { server, cwd } = this.options;
    if (server.type === "stdio") {
      if (!this.options.spawn) throw new McpError("This host cannot start stdio MCP servers");
      this.transport = "stdio";
      this.attach(new StdioTransport(this.options.spawn, { command: server.command, args: server.args, cwd,
        env: { ...server.env, OXBIT_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd } }));
      return this.settle(await this.discover(this.options.probeTimeout ?? 5000));
    }
    if (server.type === "http") {
      this.transport = "http";
      const http = this.attach(new HttpTransport(server.url, server.headers, this.options.fetch));
      http.version = MODERN_VERSION;
      const probe = await this.discover();
      if (!("legacy" in probe)) return this.settle(probe);
      try {
        await this.initialize();
        if (this.capabilities.tools?.listChanged) void http.openStream();
        return;
      } catch (error) {
        if (!(error instanceof McpError) || !RETRY_STATUSES.has(error.status ?? 0) || MODERN_ERROR_CODES.has(error.code ?? 0)) throw error;
        await http.close();
      }
    }
    this.transport = "sse";
    const sse = this.attach(new SseTransport(server.url, server.headers, this.options.fetch));
    await sse.start();
    await this.initialize();
  }
  /** `server/discover`: a result or a modern error means a 2026-07-28 server; anything else means a legacy one. */
  private async discover(timeout?: number): Promise<Probe> {
    try {
      return { result: await this.call("server/discover", {}, { timeout, modern: true }) };
    } catch (error) {
      if (!(error instanceof McpError) || error.auth) throw error;
      if (error.code === -32022) return { supported: (error.data as any)?.supported ?? [] };
      if (MODERN_ERROR_CODES.has(error.code ?? 0)) throw error;
      if (error.status !== undefined && !RETRY_STATUSES.has(error.status)) throw error;
      return { legacy: true };
    }
  }
  private async settle(probe: Probe) {
    if ("legacy" in probe) return this.initialize();
    const versions: unknown = "result" in probe ? probe.result?.supportedVersions : probe.supported;
    const list = Array.isArray(versions) ? versions.filter((item): item is string => typeof item === "string") : [];
    if (list.includes(MODERN_VERSION)) {
      this.era = "modern";
      this.version = MODERN_VERSION;
      const result = "result" in probe ? probe.result : await this.call("server/discover", {});
      this.capabilities = result?.capabilities ?? {};
      this.instructions = typeof result?.instructions === "string" ? result.instructions : undefined;
      if (this.capabilities.tools?.listChanged) this.subscribe();
      return;
    }
    if (list.some((item) => LEGACY_VERSIONS.includes(item))) return this.initialize();
    throw new McpError(`The MCP server supports protocol versions ${list.join(", ") || "none"}; Oxbit Agent supports ${[MODERN_VERSION, ...LEGACY_VERSIONS].join(", ")}`);
  }
  private async initialize() {
    if (this.channel instanceof HttpTransport) Object.assign(this.channel, { legacy: true, version: undefined });
    const result = await this.call("initialize", { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: this.options.clientInfo });
    if (!LEGACY_VERSIONS.includes(result?.protocolVersion))
      throw new McpError(`The MCP server chose protocol version ${result?.protocolVersion}, which Oxbit Agent does not support`);
    this.era = "legacy";
    this.version = result.protocolVersion;
    this.capabilities = result.capabilities ?? {};
    this.instructions = typeof result.instructions === "string" ? result.instructions : undefined;
    if (this.channel instanceof HttpTransport) this.channel.version = this.version;
    await this.channel!.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  private meta() {
    return { [`${META}protocolVersion`]: MODERN_VERSION, [`${META}clientInfo`]: this.options.clientInfo, [`${META}clientCapabilities`]: {} };
  }
  /** Long-lived `subscriptions/listen` for tool list changes. */
  private subscribe() {
    const id = this.nextId++;
    const abort = new AbortController();
    this.subscription = { id, abort };
    void this.channel!.request({ jsonrpc: "2.0", id, method: "subscriptions/listen",
      params: { notifications: { toolsListChanged: true }, _meta: this.meta() } }, abort.signal).catch(() => {});
  }
  private receive(transport: Transport, message: JsonRpcMessage) {
    if (message.method && message.id !== undefined && message.id !== null) {
      const reply: JsonRpcMessage = message.method === "ping" ? { jsonrpc: "2.0", id: message.id, result: {} }
        : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Oxbit Agent does not support ${message.method}` } };
      void transport.send(reply).catch(() => {});
      return;
    }
    if (message.method !== "notifications/tools/list_changed") return;
    const subscription = message.params?._meta?.[`${META}subscriptionId`];
    if (this.era === "modern" && subscription !== undefined && String(subscription) !== String(this.subscription?.id)) return;
    this.invalidate();
  }
  /** Drops the cached tool list so the next listTools() asks the server again. */
  invalidate() {
    this.cache = undefined;
    this.generation++;
  }
  /** Sends a request. Modern servers get `_meta` on every request; legacy ones get `notifications/cancelled` on abort. */
  async call(method: string, params: Record<string, any> = {}, options: { signal?: AbortSignal; timeout?: number; headers?: Record<string, string>; modern?: boolean } = {}) {
    const channel = this.channel;
    if (!channel || this.closed) throw new McpError("The MCP server is not connected");
    const id = this.nextId++;
    const modern = options.modern || this.era === "modern";
    const controller = new AbortController();
    const stop = () => controller.abort();
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    const timeout = options.timeout ?? this.options.requestTimeout ?? 300000;
    const timer = setTimeout(stop, timeout);
    let reply: JsonRpcMessage;
    try {
      reply = await channel.request({ jsonrpc: "2.0", id, method, params: modern ? { ...params, _meta: { ...params._meta, ...this.meta() } } : params },
        controller.signal, options.headers);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (this.era === "legacy" && !(channel instanceof StdioTransport))
        void channel.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled" } }).catch(() => {});
      throw new McpError(options.signal?.aborted ? `${method} was cancelled` : `${method} timed out after ${Math.round(timeout / 1000)} s`);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    }
    if (reply.error) throw new McpError(reply.error.message || `MCP error ${reply.error.code}`, reply.error.code, reply.error.data);
    const result = reply.result ?? {};
    if (result.resultType === "input_required")
      throw new McpError("The MCP server asked for user input or a model completion (input_required), which Oxbit Agent does not support yet");
    if (result.resultType !== undefined && result.resultType !== "complete") throw new McpError(`The MCP server sent an unknown resultType ${result.resultType}`);
    return result;
  }
  /** tools/list across all pages, cached until list_changed or the result's ttlMs. */
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    if (this.cache && this.now() < this.cache.expires) return this.cache.list;
    const generation = this.generation;
    const list: McpToolInfo[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let ttl: number | undefined;
    for (let page = 0; page < 100 && list.length < 1000; page++) {
      const result = await this.call("tools/list", cursor ? { cursor } : {}, { signal });
      for (const tool of Array.isArray(result.tools) ? result.tools : [])
        if (typeof tool?.name === "string" && tool.name) list.push(tool);
      ttl ??= Number.isFinite(result.ttlMs) && result.ttlMs >= 0 ? result.ttlMs : undefined;
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    if (generation === this.generation) this.cache = { list, expires: this.era === "modern" && ttl !== undefined ? this.now() + ttl : Infinity };
    return list;
  }
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, headers?: Record<string, string>) {
    return this.call("tools/call", { name, arguments: args }, { signal, headers });
  }
  async close() {
    this.closed = true;
    this.subscription?.abort.abort();
    const channel = this.channel;
    this.channel = undefined;
    await channel?.close().catch(() => {});
  }
}
