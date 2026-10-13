import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Params } from "@oxbit/agent-core";
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

/** The client side of ACP over any message channel. */
export abstract class AcpClient {
  protected client: JsonRpcPeer;
  private listeners = new Set<UpdateListener>();
  private permission?: PermissionHandler;
  private waiting = new Map<string, Set<AbortController>>();
  /** The initialize result. */
  initialized: Params = {};
  constructor(send: (message: Message) => void) {
    this.client = new JsonRpcPeer(send, {
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
  }
  protected async initialize(capabilities: ClientCapabilities) {
    this.initialized = await this.request("initialize",
      { protocolVersion: 1, clientCapabilities: capabilities, clientInfo: { name: "oxbit-agent", version: agentVersion() } });
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
  setMode(sessionId: string, modeId: string) {
    return this.request("session/set_mode", { sessionId, modeId });
  }
  /** session/set_model, else the `model` config option for agents without that method. */
  async setModel(sessionId: string, modelId: string) {
    try {
      return await this.request<{ configOptions: Params[] }>("session/set_model", { sessionId, modelId });
    } catch (error) {
      if ((error as { code?: unknown }).code !== -32601) throw error;
      return this.setConfigOption(sessionId, "model", modelId);
    }
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
  abstract close(): Promise<void>;
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

/** An ACP client connected in memory to an AcpServer. Messages pass through JSON like on stdio. */
export class MemoryConnection extends AcpClient {
  private server: AcpServer;
  constructor(factory: AgentFactory) {
    super((message) => this.server.receive(clone(message)));
    this.server = new AcpServer((message) => this.client.receive(clone(message)), factory);
  }
  /** Connects and sends initialize. Without fs or terminal capabilities the server serves them locally. */
  static async open(factory: AgentFactory, capabilities: ClientCapabilities = {}) {
    const connection = new MemoryConnection(factory);
    await connection.initialize(capabilities);
    return connection;
  }
  close() {
    return this.server.close("The connection was closed");
  }
}

export interface AgentCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}
const STDERR_TAIL = 4000;

/** An ACP client over an agent process's stdin and stdout. Closing ends stdin, then kills the process if it is still running after `CLOSE_GRACE_MS`. */
export class ProcessConnection extends AcpClient {
  static CLOSE_GRACE_MS = 2000;
  private stderr = "";
  private exited: Promise<void>;
  private constructor(private child: ChildProcessWithoutNullStreams, private rewrite?: (error: Error & { code?: unknown }) => Error) {
    super((message) => void (child.stdin.writable && child.stdin.write(`${JSON.stringify(message)}\n`)));
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => void (this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL)));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (!line.trim()) return;
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.client.receive(message);
    });
    this.exited = new Promise((resolve) => child.once("close", (code, signal) => {
      this.client.close(`The agent exited (${signal ?? `code ${code}`})${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""}`);
      resolve();
    }));
  }
  /** Starts `agent` in `cwd` and sends initialize. `rewrite` replaces error replies, such as an auth_required error with sign-in steps. */
  static async open(agent: AgentCommand, cwd: string, options: { capabilities?: ClientCapabilities; rewrite?(error: Error & { code?: unknown }): Error } = {}) {
    const child = spawn(agent.command, agent.args, { cwd, env: agent.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const failed = new Promise<never>((_, reject) => child.once("error", (error) => reject(new Error(`Could not start ${agent.command}: ${error.message}`))));
    const connection = new ProcessConnection(child, options.rewrite);
    try {
      await Promise.race([connection.initialize(options.capabilities ?? {}), failed]);
    } catch (error) {
      await connection.close();
      throw error;
    }
    return connection;
  }
  override async request<T = any>(method: string, params: Params = {}): Promise<T> {
    try {
      return await super.request<T>(method, params);
    } catch (error) {
      throw this.rewrite?.(error as Error) ?? error;
    }
  }
  async close() {
    if (this.child.pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), ProcessConnection.CLOSE_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }
}
