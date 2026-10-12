import type { AgentCommand, AgentTool, CommandProvider, HookRunner, SessionView, ToolProvider } from "../extensions.js";
import type { Fetch } from "../providers/http.js";
import { McpClient, type McpToolInfo } from "./client.js";
import { mergeServers, parseAcpServers, parseMcpJson, type McpScope, type McpServerConfig } from "./config.js";
import { McpError } from "./jsonrpc.js";
import { headerParams, paramHeaders, renderResult, toolName, toolSchema } from "./render.js";
import type { Spawn } from "./stdio.js";

export interface McpToolsOptions {
  fetch: Fetch;
  /** Starts stdio servers. Without it, stdio entries report an error. */
  spawn?: Spawn;
  /** Reads a UTF-8 file and resolves undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** The user-level mcp.json path. */
  globalConfig?: string;
  /** Values for `${VAR}` expansion in mcp.json files. */
  env?: Record<string, string | undefined>;
  /** Whether `<cwd>/.mcp.json` loads. Without it, project servers are skipped. */
  trustProject?(cwd: string): boolean | Promise<boolean>;
  /** Added to the /mcp warning that names an untrusted project's servers. */
  trustHint?: string;
  clientInfo?: { name: string; version: string };
  /** Defaults: connect 30 s, tool calls 300 s (an entry's `timeout` wins), idle close 10 min (0 turns it off), retry after a failed connect 60 s. */
  connectTimeout?: number;
  callTimeout?: number;
  idleMs?: number;
  retryMs?: number;
  now?(): number;
}
export interface McpServerStatus {
  name: string;
  scope: McpScope;
  type: McpServerConfig["type"];
  state: "idle" | "connecting" | "connected" | "failed";
  /** The negotiated protocol version. */
  version?: string;
  tools: number;
  /** Tools left out because of invalid `x-mcp-header` annotations. */
  excluded: number;
  error?: string;
}
interface ServerState {
  config: McpServerConfig;
  client?: McpClient;
  connecting?: Promise<McpClient | undefined>;
  error?: string;
  failedAt?: number;
  tools: number;
  excluded: number;
}
interface SessionState {
  key: string;
  cwd: string;
  servers: ServerState[];
  warnings: string[];
  closed: boolean;
  active: number;
  timer?: ReturnType<typeof setTimeout>;
}

const CLIENT_INFO = { name: "oxbit-agent", version: "1" };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const sessionKey = (session: SessionView) => `${session.cwd}\n${JSON.stringify(session.meta.mcpServers ?? null)}`;

/** MCP servers as `mcp__<server>__<tool>` tools. Connects per session on first use; SessionEnd, idle time or close() disconnects. */
export class McpTools implements ToolProvider, CommandProvider {
  private sessions = new Map<string, SessionState>();
  private loading = new Map<string, Promise<SessionState>>();
  constructor(private options: McpToolsOptions) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  /** Global, then trusted project, then ACP session servers; later scopes replace earlier entries with the same name. */
  async configure(session: SessionView) {
    const warnings: string[] = [];
    const lists: McpServerConfig[][] = [];
    const load = async (path: string, scope: McpScope) => {
      const text = await this.options.read(path).catch((error) => void warnings.push(`${path}: ${message(error)}`));
      if (text === undefined) return;
      const parsed = parseMcpJson(text, scope, this.options.env ?? {}, path);
      lists.push(parsed.servers);
      warnings.push(...parsed.warnings);
    };
    if (this.options.globalConfig) await load(this.options.globalConfig, "global");
    const project = `${session.cwd.replace(/[\\/]+$/, "")}/.mcp.json`;
    if (await this.options.trustProject?.(session.cwd)) await load(project, "project");
    else if (this.options.trustProject) {
      const text = await this.options.read(project).catch(() => undefined);
      const names = text === undefined ? [] : parseMcpJson(text, "project", {}, project).servers.map((server) => server.name);
      if (names.length) warnings.push(`${project} is not trusted, so its servers are off: ${names.join(", ")}.${this.options.trustHint ? ` ${this.options.trustHint}` : ""}`);
    }
    const acp = parseAcpServers(session.meta.mcpServers);
    lists.push(acp.servers);
    warnings.push(...acp.warnings);
    return { servers: mergeServers(...lists), warnings };
  }
  private async state(session: SessionView) {
    const key = sessionKey(session);
    const current = this.sessions.get(session.id);
    if (current?.key === key) return current;
    const pending = this.loading.get(session.id) ?? (async () => {
      const { servers, warnings } = await this.configure(session);
      const state: SessionState = { key, cwd: session.cwd, servers: servers.map((config) => ({ config, tools: 0, excluded: 0 })), warnings, closed: false, active: 0 };
      const previous = this.sessions.get(session.id);
      this.sessions.set(session.id, state);
      if (previous) await this.shut(previous);
      return state;
    })().finally(() => this.loading.delete(session.id));
    this.loading.set(session.id, pending);
    return pending;
  }
  private connect(state: SessionState, server: ServerState, force = false): Promise<McpClient | undefined> {
    if (server.client && !server.client.closed) return Promise.resolve(server.client);
    if (server.connecting) return server.connecting;
    if (state.closed || !force && server.failedAt !== undefined && this.now() - server.failedAt < (this.options.retryMs ?? 60000))
      return Promise.resolve(undefined);
    const client: McpClient = new McpClient({ server: server.config, cwd: state.cwd, fetch: this.options.fetch, spawn: this.options.spawn,
      clientInfo: this.options.clientInfo ?? CLIENT_INFO, connectTimeout: this.options.connectTimeout,
      requestTimeout: server.config.timeout ?? this.options.callTimeout, now: this.options.now,
      onClose: (error) => {
        if (server.client !== client) return;
        server.client = undefined;
        server.error = error.message;
      } });
    const connecting = client.connect().then(async () => {
      if (state.closed) {
        await client.close();
        return undefined;
      }
      Object.assign(server, { client, error: undefined, failedAt: undefined });
      return client;
    }, (error) => {
      Object.assign(server, { error: message(error), failedAt: this.now() });
      return undefined;
    }).finally(() => {
      if (server.connecting === connecting) server.connecting = undefined;
    });
    server.connecting = connecting;
    return connecting;
  }
  /** Runs `work`; reconnects once when a legacy HTTP session expired (404), or, with `restart`, when the server exited. */
  private async use<T>(state: SessionState, server: ServerState, work: (client: McpClient) => Promise<T>, restart: boolean): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.connect(state, server, attempt > 0);
      if (!client) throw new Error(`MCP server "${server.config.name}" is not connected${server.error ? `: ${server.error}` : ""}`);
      try {
        return await work(client);
      } catch (error) {
        const expired = error instanceof McpError && error.status === 404 && client.era === "legacy" && client.transport === "http";
        if (attempt > 0 || !(expired || restart && client.closed)) throw error;
        if (server.client === client) server.client = undefined;
        await client.close();
      }
    }
  }
  private touch(state: SessionState) {
    const idle = this.options.idleMs ?? 600000;
    if (!idle || state.closed) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (state.active > 0) return this.touch(state);
      for (const server of state.servers) this.disconnect(server);
    }, idle);
    (state.timer as { unref?(): void }).unref?.();
  }
  private disconnect(server: ServerState) {
    const client = server.client;
    server.client = undefined;
    return client?.close();
  }
  private tool(state: SessionState, server: ServerState, info: McpToolInfo, taken: Set<string>): AgentTool | undefined {
    const params = headerParams(info.inputSchema);
    if (!params) {
      server.excluded++;
      return undefined;
    }
    const label = info.title || info.annotations?.title || info.name;
    const name = server.config.name;
    return {
      spec: { name: toolName(name, info.name, taken), description: (info.description || `${label} from the ${name} MCP server`).slice(0, 2048),
        parameters: toolSchema(info.inputSchema) },
      kind: "execute",
      title: () => `${name}: ${label}`,
      run: async (args, context) => {
        state.active++;
        this.touch(state);
        try {
          return renderResult(await this.use(state, server, (client) => client.callTool(info.name, args, context.signal,
            client.era === "modern" && client.transport === "http" ? paramHeaders(params, args) : undefined), false));
        } finally {
          state.active--;
          this.touch(state);
        }
      },
    };
  }
  async tools(session: SessionView): Promise<AgentTool[]> {
    const state = await this.state(session);
    this.touch(state);
    const lists = await Promise.all(state.servers.map(async (server) => {
      try {
        const list = await this.use(state, server, (client) => client.listTools(), true);
        server.error = undefined;
        return list;
      } catch (error) {
        if (server.client) server.error = message(error);
        return [];
      }
    }));
    const taken = new Set<string>();
    return state.servers.flatMap((server, index) => {
      server.excluded = 0;
      const tools = lists[index].map((info) => this.tool(state, server, info, taken)).filter((tool): tool is AgentTool => !!tool);
      server.tools = tools.length;
      return tools;
    });
  }
  status(sessionId: string): { servers: McpServerStatus[]; warnings: string[] } {
    const state = this.sessions.get(sessionId);
    return { warnings: state?.warnings ?? [], servers: (state?.servers ?? []).map((server) => ({
      name: server.config.name, scope: server.config.scope, type: server.config.type, tools: server.tools, excluded: server.excluded,
      state: server.client && !server.client.closed ? "connected" : server.connecting ? "connecting" : server.error ? "failed" : "idle",
      ...server.client?.version ? { version: server.client.version } : {}, ...server.error ? { error: server.error } : {},
    })) };
  }
  private report(sessionId: string) {
    const { servers, warnings } = this.status(sessionId);
    const lines = servers.length ? [`MCP servers (${servers.length}):`] : ["No MCP servers are configured for this session."];
    for (const server of servers) {
      const detail = server.state === "connected" ? `connected, ${server.tools} tools${server.excluded ? `, ${server.excluded} left out` : ""}`
        : server.state === "failed" ? `failed: ${server.error}` : server.state;
      lines.push(`- ${server.name} (${server.scope}, ${server.type}${server.version ? `, ${server.version}` : ""}): ${detail}`);
    }
    if (warnings.length) lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
    return lines.join("\n");
  }
  commands(): AgentCommand[] {
    return [{ name: "mcp", description: "Show MCP servers; /mcp reload reconnects them", hint: "reload", run: async (args, context) => {
      const reload = args.trim() === "reload";
      if (reload) await this.close(context.session.id);
      await this.tools(context.session);
      context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: this.report(context.session.id) } });
      return { done: "end_turn" };
    } }];
  }
  private async shut(state: SessionState) {
    state.closed = true;
    clearTimeout(state.timer);
    await Promise.all(state.servers.map(async (server) => {
      await this.disconnect(server);
      await server.connecting;
    }));
  }
  /** Disconnects a session's servers. The next tools() call connects again. */
  async close(sessionId: string) {
    const state = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (state) await this.shut(state);
  }
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.close(sessionId)));
  }
  /** Wraps the host's HookRunner so SessionEnd closes that session's servers after `next` runs. */
  hooks(next?: HookRunner): HookRunner {
    return { run: async (event, input, signal) => {
      try {
        return next ? await next.run(event, input, signal) : {};
      } finally {
        if (event === "SessionEnd" && typeof input.session_id === "string") await this.close(input.session_id);
      }
    } };
  }
}
