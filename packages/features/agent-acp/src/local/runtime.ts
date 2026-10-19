import { MISSING_AGENT_KEY, MISSING_CHATGPT_SIGN_IN, OXBIT_AGENT_PROVIDER, OXBIT_AGENT_SETTINGS, type ACPConnection, type ACPQueuedPrompt, type AgentModels,
  type FeatureOptions, type Persistence, type RpcClient, type Unsubscribe } from "@oxbit/sdk";
import { SubagentRegistry } from "@oxbit/sdk/acp-subagents";
import { Agent, BUILTIN_MODELS, fillLimits, listModels, relativePath, resolvePath, type ModelInfo, type RetryPolicy } from "@oxbit/agent-core";
import { oxbitEndpoint } from "../configuration.js";
import { compactSettings, localExtensions } from "./extensions.js";
import { StoredSessions, memoryPersistence } from "./sessions.js";

type Params = Record<string, any>;
type Approval = { method: string; params: Params; resolve: (result: unknown) => void; reject: (error: Error) => void };
interface Connection {
  connection: ACPConnection;
  agent: Agent;
  settings: ReturnType<typeof compactSettings>;
  seq: number;
  busy: boolean;
  stopped: boolean;
  queue: ACPQueuedPrompt[];
  queuePaused: boolean;
  queueRunning: boolean;
  approvals: Map<string, Approval>;
  subagents?: SubagentRegistry;
}

const MAX_BYTES = 1024 * 1024;
const withoutImageData = (value: unknown) => JSON.parse(JSON.stringify(value ?? [], (key, item) => key === "data" ? undefined : item));
const text = (params: Params, key: string, limit = MAX_BYTES) => {
  const value = params[key];
  if (typeof value !== "string" || value.length > limit) throw new Error(`Invalid ${key}`);
  return value;
};
const toolCallId = (params: Params): string | undefined => params.toolCallId ?? params.toolCall?.toolCallId;
const optionalId = (params: Params) => params.messageId === undefined ? crypto.randomUUID() : text(params, "messageId", 256);

/** The workspace root: the host filesystem's absolute root, or a stable path from its ID. */
export function workspaceRoot(filesystem: FeatureOptions["filesystem"]) {
  const root = (filesystem as { root?: unknown }).root;
  return typeof root === "string" && root.startsWith("/") ? root.replace(/\/+$/, "") || "/" : `/${filesystem.id}`;
}

/** The acp.* runtime surface for the built-in Oxbit agent, served in the app without a runtime process.
 * Sessions are saved in the workbench's host storage, or in memory when the host has none. */
export class LocalAgentRuntime implements RpcClient {
  readonly local = true;
  private listeners = new Map<string, Set<(params: any) => void>>();
  private connections = new Map<string, Connection>();
  private root: string;
  private sessions: StoredSessions;
  constructor(private options: FeatureOptions, private models: () => AgentModels | undefined, private retry?: RetryPolicy) {
    this.root = workspaceRoot(options.filesystem);
    const persistence = (options.workbench as { persistence?: Persistence } | undefined)?.persistence;
    this.sessions = new StoredSessions(persistence ?? memoryPersistence(), options.filesystem.id, this.root);
  }
  get connected() {
    return !!this.models();
  }
  subscribe(event: string, listener: (params: any) => void): Unsubscribe {
    const listeners = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  async request<T>(method: string, params: Record<string, unknown> = {}, options: { signal?: AbortSignal; id?: string } = {}): Promise<T> {
    // The device git client has no branch diff; outside a repository it would report that instead of a missing method.
    if (method.startsWith("git.") && method !== "git.branchDiff" && this.options.git) return this.options.git.request<T>(method, params, options);
    return (await this.handle(method, params as Params, options.signal)) as T;
  }
  private async handle(method: string, params: Params, signal?: AbortSignal) {
    switch (method) {
      case "acp.start":
        if (params.provider !== OXBIT_AGENT_PROVIDER) break;
        return this.start(signal);
      case "acp.call": return this.call(this.get(params.id), text(params, "method"), params.params ?? {});
      case "acp.cancel": return this.cancel(this.get(params.id));
      case "acp.respond": return this.respond(this.get(params.id), text(params, "requestId"), params.result, params.error);
      case "acp.stop": return this.stop(this.get(params.id), "Agent disconnected");
      case "acp.enqueue":
      case "acp.interrupt": return this.enqueue(this.get(params.id), params, method === "acp.interrupt");
      case "acp.dequeue": return this.dequeue(this.get(params.id), text(params, "promptId"));
      case "acp.moveQueued": return this.moveQueued(this.get(params.id), text(params, "promptId"), params.index);
      case "acp.resumeQueue": {
        const connection = this.get(params.id);
        connection.queuePaused = false;
        this.publishQueue(connection);
        queueMicrotask(() => this.runQueue(connection));
        return {};
      }
      case "acp.detach":
      case "acp.disconnect": return {};
      case "acp.registry": return { agents: [], fetchedAt: new Date().toISOString(), error: "The ACP Registry needs a runtime workspace" };
      case "acp.checkpoint.create": return { unavailable: "failed" };
    }
    throw new Error(`${method} needs a runtime workspace`);
  }
  private get(id: unknown) {
    const connection = typeof id === "string" ? this.connections.get(id) : undefined;
    if (!connection || connection.stopped) throw new Error("Agent connection has ended");
    return connection;
  }
  private publish(connection: Connection, event: string, params: Params) {
    const payload = { id: connection.connection.id, ...params, seq: ++connection.seq };
    for (const listener of [...this.listeners.get(event) ?? []]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(error);
      }
    }
  }
  private publishQueue(connection: Connection) {
    this.publish(connection, "acp.queue", { queue: connection.queue, paused: connection.queuePaused });
    return { queue: [...connection.queue], paused: connection.queuePaused };
  }
  /** The listed models with context and output limits from the built-in table; that table stands in when listing fails. */
  private async catalog(endpoint: ReturnType<typeof oxbitEndpoint>) {
    const builtin = endpoint.api === "openai" || endpoint.api === "anthropic" ? endpoint.api : undefined;
    let listed: ModelInfo[];
    try {
      listed = await listModels(this.models()!, endpoint);
    } catch (error) {
      if (!builtin) throw error;
      listed = BUILTIN_MODELS[builtin].map((model) => ({ ...model }));
    }
    return fillLimits(listed, { builtin });
  }
  private async start(signal?: AbortSignal) {
    const models = this.models();
    if (!models) throw new Error("Connect to a runtime workspace first");
    const endpoint = oxbitEndpoint(this.options.kernel.configuration);
    if (!(await models.keys.has(endpoint))) throw new Error(endpoint.api === "chatgpt" ? MISSING_CHATGPT_SIGN_IN : MISSING_AGENT_KEY);
    if (signal?.aborted) throw new Error("Agent connection cancelled");
    const id = crypto.randomUUID();
    const live = () => this.connections.get(id);
    const configuration = this.options.kernel.configuration;
    const update = (sessionId: string, update: Record<string, any>) => {
      const connection = live();
      const registry = connection?.subagents;
      if (!connection || !registry?.observe(sessionId, update)) return;
      if (sessionId === registry.root && update.sessionUpdate === "current_mode_update" && connection.connection.modes)
        connection.connection.modes.currentModeId = update.currentModeId;
      // The controller shows root updates, which covers the replay of session/load; child updates reach it as acp.subagent.
      this.publish(connection, "acp.update", { rootSessionId: registry.root, sessionId, update });
      if (update.sessionUpdate === "subagent_state_update" && !registry.acceptsRequest(update.subagentSessionId))
        this.expire(connection, update.subagentSessionId);
    };
    const { extensions, settings } = localExtensions({ filesystem: this.options.filesystem, root: this.root, configuration, sessions: this.sessions, update });
    let catalog: Promise<ModelInfo[]> | undefined;
    const agent = new Agent({
      catalog: () => catalog ??= this.catalog(oxbitEndpoint(configuration)).catch((error) => {
        catalog = undefined;
        throw error;
      }),
      models: this.models, endpoint: () => oxbitEndpoint(configuration), capabilities: { fs: true, terminal: false, childSessions: true }, subagents: {},
      model: () => configuration.get<string>(OXBIT_AGENT_SETTINGS.model),
      saveModel: (model) => configuration.set(OXBIT_AGENT_SETTINGS.model, model, "user"),
      filesystem: this.options.filesystem, root: this.root, generateTitles: false, update,
      request: (method, params) => {
        const connection = live();
        return connection ? this.clientRequest(connection, method, params) : Promise.reject(new Error("Agent connection has ended"));
      },
      configOptions: () => settings.options(),
      setConfigOption: (_session, configId, value) => settings.set(configId, value),
      extensions, retry: this.retry,
    });
    const initialized = agent.initialize();
    const connection: Connection = {
      connection: { id, provider: OXBIT_AGENT_PROVIDER, name: "Oxbit Agent", root: this.root, authMethods: [],
        agentInfo: initialized.agentInfo, capabilities: initialized.agentCapabilities },
      agent, settings, seq: 0, busy: false, stopped: false, queue: [], queuePaused: false, queueRunning: false, approvals: new Map(),
    };
    this.connections.set(connection.connection.id, connection);
    return structuredClone(connection.connection);
  }
  private async call(connection: Connection, method: string, params: Params): Promise<unknown> {
    if (connection.busy) throw new Error("Wait for the current agent operation or stop it first");
    if (method === "session/list") return { sessions: (await connection.agent.listSessions({ cwd: this.root })).sessions.slice(0, 200) };
    if (method === "session/new" || method === "session/fork" || method === "session/load") {
      if (connection.subagents?.activeCount) throw new Error("Wait for active subagents or disconnect before changing conversations");
      if (connection.approvals.size) throw new Error("Resolve pending requests before changing conversations");
      if (connection.queue.length) throw new Error("Remove queued messages before changing conversations");
      const source = connection.connection.sessionId;
      if (method === "session/fork" && !source) throw new Error("Start a conversation first");
      const { sessionId, modes, models, configOptions } = connection.connection;
      const previousRegistry = connection.subagents;
      connection.busy = true;
      try {
        let result;
        if (method === "session/load") {
          // The agent replays the conversation before it answers; updates reach the client for the loaded session and its children only.
          connection.connection.sessionId = text(params, "sessionId", 128);
          connection.subagents = this.registry(connection, connection.connection.sessionId, true);
          result = await connection.agent.loadSession({ sessionId: connection.connection.sessionId, cwd: this.root });
          connection.subagents.replaying = false;
        } else {
          connection.subagents = undefined;
          result = method === "session/fork" ? connection.agent.forkSession(source!) : await connection.agent.newSession();
          connection.subagents = this.registry(connection, result.sessionId);
        }
        Object.assign(connection.connection, result);
        connection.queuePaused = false;
        return structuredClone(connection.connection);
      } catch (error) {
        Object.assign(connection.connection, { sessionId, modes, models, configOptions });
        connection.subagents = previousRegistry;
        throw error;
      } finally {
        connection.busy = false;
      }
    }
    const sessionId = connection.connection.sessionId;
    if (!sessionId) throw new Error("Start a conversation first");
    if (method === "session/set_mode") {
      const result = connection.agent.setMode(sessionId, text(params, "modeId"));
      if (connection.connection.modes) connection.connection.modes.currentModeId = params.modeId;
      return result;
    }
    if (method === "session/set_model" || method === "session/set_config_option") {
      const result = method === "session/set_model"
        ? connection.agent.setModel(sessionId, text(params, "modelId"))
        : await connection.agent.setConfigOption(sessionId, text(params, "configId"), text(params, "value"));
      connection.connection.configOptions = result.configOptions;
      const model = result.configOptions.find((option) => option.id === "model")?.currentValue;
      if (connection.connection.models && model) connection.connection.models.currentModelId = model;
      const mode = result.configOptions.find((option) => option.id === "mode")?.currentValue;
      if (connection.connection.modes && mode) connection.connection.modes.currentModeId = mode;
      return structuredClone(result);
    }
    if (method !== "session/prompt") throw new Error("Unsupported ACP client method");
    return this.prompt(connection, sessionId, params);
  }
  /** Validates attached context and converts it into ACP embedded resources. */
  private contextBlocks(context: unknown) {
    if (context === undefined) return [];
    if (!Array.isArray(context) || context.length > 8) throw new Error("Attach up to eight context items");
    return context.map((item: Params) => {
      if (item?.kind === "image") throw new Error("This agent does not accept images");
      const content = text(item ?? {}, "text", 200000);
      const { relative, absolute } = resolvePath(this.root, text(item, "path"));
      const label = typeof item.label === "string" ? item.label.slice(0, 1024) : relative || ".";
      return { type: "resource", resource: { uri: encodeURI(`file://${absolute}`) + (Number.isSafeInteger(item.line) ? `#L${item.line}` : ""),
        mimeType: "text/plain", text: `Editor snapshot: ${label}\n${content}` } };
    });
  }
  private async prompt(connection: Connection, sessionId: string, params: Params) {
    const message = text(params, "text");
    if (!message.trim()) throw new Error("Enter a message");
    const blocks = [{ type: "text", text: message }, ...this.contextBlocks(params.context)];
    const messageId = optionalId(params);
    connection.busy = true;
    if (connection.queuePaused) {
      connection.queuePaused = false;
      this.publishQueue(connection);
    }
    this.publish(connection, "acp.turnStarted", { messageId, text: message, context: withoutImageData(params.context) });
    let stopReason: string | undefined;
    let failure: string | undefined;
    try {
      const result = await connection.agent.prompt(sessionId, blocks);
      stopReason = result.stopReason;
      if (stopReason !== "end_turn" && stopReason !== "cancelled") connection.queuePaused = true;
      return result;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      connection.queuePaused = true;
      throw error;
    } finally {
      this.expire(connection, sessionId);
      connection.busy = false;
      if (!connection.stopped) {
        this.refreshOptions(connection, sessionId);
        this.publish(connection, "acp.turnEnded", { stopReason, error: failure });
        this.publishQueue(connection);
        queueMicrotask(() => this.runQueue(connection));
      }
    }
  }
  /** /config changes settings inside a turn; config_option_update sends the new values. */
  private refreshOptions(connection: Connection, sessionId: string) {
    const current = connection.connection.configOptions;
    if (!current || connection.connection.sessionId !== sessionId) return;
    const fresh = new Map(connection.settings.options().map((option) => [option.id, option]));
    const mode = connection.connection.modes?.currentModeId;
    const next = current.map((option) => fresh.get(option.id) ?? (option.id === "mode" && mode ? { ...option, currentValue: mode } : option));
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    connection.connection.configOptions = next;
    this.publish(connection, "acp.update", { sessionId, update: { sessionUpdate: "config_option_update", configOptions: next } });
  }
  private registry(connection: Connection, root: string, replaying = false) {
    const registry = new SubagentRegistry(OXBIT_AGENT_PROVIDER, root, (event) =>
      this.publish(connection, "acp.subagent", { rootSessionId: root, ...event }));
    registry.replaying = replaying;
    return registry;
  }
  private settle(connection: Connection, requestId: string, params: Params) {
    connection.subagents?.waiting(params.sessionId, requestId, false, toolCallId(params));
  }
  private clientRequest(connection: Connection, method: string, params: Params): Promise<any> {
    const registry = connection.subagents;
    if (!registry?.acceptsRequest(params.sessionId)) return Promise.reject(new Error("Unknown ACP session"));
    if (connection.approvals.size >= 32) return Promise.reject(new Error("Too many pending agent requests"));
    const request = { ...params };
    try {
      if (method.startsWith("fs/")) request.path = relativePath(this.root, params.path);
    } catch (error) {
      return Promise.reject(error);
    }
    for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const sessionId = request.sessionId;
      connection.approvals.set(requestId, { method, params: request, resolve, reject });
      if (method !== "fs/read_text_file" && !method.startsWith("oxbit/")) registry.waiting(sessionId, requestId, true, toolCallId(request));
      this.publish(connection, "acp.request", { requestId, sessionId, rootSessionId: registry.root,
        subagentId: registry.idForSession(sessionId) ?? registry.idForTool(sessionId, toolCallId(request)!), method, params: request });
    });
  }
  private respond(connection: Connection, requestId: string, result: unknown, error: unknown) {
    const request = connection.approvals.get(requestId);
    if (!request) throw new Error("Agent request has expired");
    connection.approvals.delete(requestId);
    this.settle(connection, requestId, request.params);
    if (error !== undefined && error !== null) request.reject(new Error(String(error).slice(0, 4096)));
    else request.resolve(result);
    return {};
  }
  private expire(connection: Connection, sessionId: string) {
    const requestIds: string[] = [];
    for (const [id, request] of connection.approvals) {
      if (request.params.sessionId !== sessionId) continue;
      connection.approvals.delete(id);
      this.settle(connection, id, request.params);
      request.reject(new Error("Session turn ended"));
      requestIds.push(id);
    }
    if (requestIds.length) this.publish(connection, "acp.requestsExpired", { requestIds });
  }
  private cancel(connection: Connection, continueQueue = false) {
    const sessionId = connection.connection.sessionId;
    connection.queuePaused = !continueQueue;
    this.publishQueue(connection);
    if (sessionId) connection.agent.cancel(sessionId);
    for (const [id, request] of connection.approvals) {
      if (request.params.sessionId !== sessionId) continue;
      connection.approvals.delete(id);
      this.settle(connection, id, request.params);
      request.reject(new Error("Cancelled"));
    }
    this.publish(connection, "acp.cancelled", { sessionId });
    return {};
  }
  dispose() {
    for (const connection of [...this.connections.values()]) this.stop(connection, "Workspace closed");
    this.listeners.clear();
  }
  private stop(connection: Connection, reason: string) {
    if (connection.stopped) return {};
    connection.stopped = true;
    connection.agent.cancel();
    for (const request of connection.approvals.values()) request.reject(new Error(reason));
    connection.approvals.clear();
    connection.subagents?.disconnect();
    this.connections.delete(connection.connection.id);
    this.publish(connection, "acp.exit", { reason });
    return {};
  }
  private enqueue(connection: Connection, params: Params, interrupt: boolean) {
    if (!connection.connection.sessionId) throw new Error("Start a conversation first");
    const message = text(params, "text").trim();
    if (!message) throw new Error("Enter a message");
    const messageId = optionalId(params);
    this.contextBlocks(params.context);
    if (connection.queue.some((prompt) => prompt.id === messageId)) return this.publishQueue(connection);
    if (connection.queue.length >= 16) throw new Error("Queued messages exceed the limit; remove a message first");
    const prompt: ACPQueuedPrompt = { id: messageId, text: message, ...(params.context ? { context: structuredClone(params.context) } : {}) };
    if (interrupt) {
      connection.queue.unshift(prompt);
      connection.queuePaused = false;
      if (connection.busy) this.cancel(connection, true);
    } else connection.queue.push(prompt);
    const result = this.publishQueue(connection);
    queueMicrotask(() => this.runQueue(connection));
    return result;
  }
  private dequeue(connection: Connection, promptId: string) {
    const index = connection.queue.findIndex((prompt) => prompt.id === promptId);
    if (index < 0) throw new Error("The queued message has already started or was removed");
    const [prompt] = connection.queue.splice(index, 1);
    this.publishQueue(connection);
    return { prompt };
  }
  private moveQueued(connection: Connection, promptId: string, index: unknown) {
    if (!Number.isInteger(index)) throw new Error("Invalid index");
    const from = connection.queue.findIndex((prompt) => prompt.id === promptId);
    if (from < 0) throw new Error("The queued message has already started or was removed");
    const [prompt] = connection.queue.splice(from, 1);
    connection.queue.splice(Math.max(0, Math.min(index as number, connection.queue.length)), 0, prompt);
    return this.publishQueue(connection);
  }
  private runQueue(connection: Connection) {
    if (connection.busy || connection.queueRunning || connection.stopped || connection.queuePaused || !connection.queue.length) return;
    connection.queueRunning = true;
    const prompt = connection.queue.shift()!;
    this.publishQueue(connection);
    void this.call(connection, "session/prompt", { text: prompt.text, context: prompt.context, messageId: prompt.id }).catch(() => {
      if (connection.stopped) return;
      connection.queuePaused = true;
      connection.queue.unshift(prompt);
      this.publishQueue(connection);
    }).finally(() => {
      connection.queueRunning = false;
      this.runQueue(connection);
    });
  }
}
