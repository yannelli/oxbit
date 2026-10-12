import type { Params, PermissionMode } from "@oxbit/agent-core";
import { AcpServer, JsonRpcPeer, type Message } from "./acp-server.js";
import type { AgentFactory, ClientCapabilities } from "./host.js";
import { agentVersion } from "./version.js";

export interface PermissionOption { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }
export interface PermissionRequest { sessionId: string; toolCall: Params; options: PermissionOption[] }
export type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
export type UpdateListener = (sessionId: string, update: Params) => void;
/** `signal` aborts when the turn is cancelled; the connection then answers "cancelled" itself. */
export type PermissionHandler = (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionOutcome>;
/** session/new and session/load results. */
export interface SessionState {
  sessionId: string;
  models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] };
  modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] };
  configOptions?: Params[];
}

const clone = (message: Message): Message => JSON.parse(JSON.stringify(message));

/** An ACP client connected in memory to an AcpServer. Messages pass through JSON like on stdio. */
export class MemoryConnection {
  private server: AcpServer;
  private client: JsonRpcPeer;
  private listeners = new Set<UpdateListener>();
  private permission?: PermissionHandler;
  private waiting = new Map<string, Set<AbortController>>();
  /** The initialize result. */
  initialized: Params = {};
  constructor(factory: AgentFactory) {
    this.client = new JsonRpcPeer((message) => this.server.receive(clone(message)), {
      request: (method, params) => this.serve(method, params),
      notification: (method, params) => {
        if (method !== "session/update") return;
        for (const listener of [...this.listeners]) {
          try {
            listener(params.sessionId, params.update);
          } catch {
            // A failing listener must not stop the agent.
          }
        }
      },
    });
    this.server = new AcpServer((message) => this.client.receive(clone(message)), factory);
  }
  /** Connects and sends initialize. Without fs or terminal capabilities the server serves them locally. */
  static async open(factory: AgentFactory, capabilities: ClientCapabilities = {}) {
    const connection = new MemoryConnection(factory);
    connection.initialized = await connection.request("initialize",
      { protocolVersion: 1, clientCapabilities: capabilities, clientInfo: { name: "oxbit-agent", version: agentVersion() } });
    return connection;
  }
  request<T = any>(method: string, params: Params = {}): Promise<T> {
    return this.client.request(method, params);
  }
  newSession(params: { cwd?: string; mcpServers?: unknown[] } = {}) {
    return this.request<SessionState>("session/new", { mcpServers: [], ...params });
  }
  /** Replays the saved turns through onUpdate before it resolves. */
  loadSession(sessionId: string, params: { cwd?: string; mcpServers?: unknown[] } = {}) {
    return this.request<SessionState>("session/load", { sessionId, mcpServers: [], ...params });
  }
  listSessions(cwd?: string) {
    return this.request<{ sessions: { sessionId: string; cwd: string; title: string; updatedAt: string }[] }>("session/list", cwd ? { cwd } : {});
  }
  prompt(sessionId: string, prompt: string | Params[]) {
    const blocks = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
    return this.request<{ stopReason: string }>("session/prompt", { sessionId, prompt: blocks });
  }
  /** Sends session/cancel and answers this session's open permission prompts with "cancelled". */
  cancel(sessionId: string) {
    this.client.notify("session/cancel", { sessionId });
    for (const controller of this.waiting.get(sessionId) ?? []) controller.abort();
  }
  setMode(sessionId: string, modeId: PermissionMode) {
    return this.request("session/set_mode", { sessionId, modeId });
  }
  setModel(sessionId: string, modelId: string) {
    return this.request<{ configOptions: Params[] }>("session/set_model", { sessionId, modelId });
  }
  setConfigOption(sessionId: string, configId: string, value: string) {
    return this.request<{ configOptions: Params[] }>("session/set_config_option", { sessionId, configId, value });
  }
  onUpdate(listener: UpdateListener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  /** One handler at a time. Without one, permission prompts resolve as "cancelled". */
  onPermission(handler: PermissionHandler) {
    this.permission = handler;
    return () => {
      if (this.permission === handler) this.permission = undefined;
    };
  }
  close() {
    return this.server.close("The connection was closed");
  }
  private async serve(method: string, params: Params) {
    if (method !== "session/request_permission") throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    const handler = this.permission;
    if (!handler) return { outcome: { outcome: "cancelled" } };
    const controller = new AbortController();
    const set = this.waiting.get(params.sessionId) ?? new Set();
    this.waiting.set(params.sessionId, set.add(controller));
    const cancelled = new Promise<PermissionOutcome>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }), { once: true }));
    try {
      return { outcome: await Promise.race([handler(params as PermissionRequest, controller.signal), cancelled]) };
    } finally {
      set.delete(controller);
      if (!set.size) this.waiting.delete(params.sessionId);
    }
  }
}
