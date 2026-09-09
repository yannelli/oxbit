import {
  ACP_PROVIDERS,
  type ACPConnection,
  type ACPLaunch,
  type ACPContext,
  type ACPSessionInfo,
  type ACPSubagent,
  type ACPSubagentEvent,
  type FeatureOptions,
} from "@oxbit/sdk";
import type { DocumentService } from "@oxbit/documents";
import { sessionControls, type SessionControl } from "./session-controls.js";
import type { Persistence } from "@oxbit/sdk";
import {
  ConversationHistory,
  type Activity,
  type Conversation,
  type Message,
} from "./history.js";
export type { Message } from "./history.js";

export type AgentRequest = {
  id: string;
  requestId: string;
  sessionId?: string;
  rootSessionId?: string;
  subagentId?: string;
  method: string;
  params: Record<string, any>;
  before?: string;
  revision?: string | null;
  version?: number;
  error?: string;
};
export class AgentController {
  private listeners = new Set<() => void>();
  private revision = 0;
  private subscriptions: (() => void)[] = [];
  private disposed = false;
  private requestGeneration = 0;
  private rootRequestGeneration = 0;
  private pendingClientRequests = new Map<string, { expired: boolean }>();
  private connectionGeneration = 0;
  private sessionStarting = false;
  private startAbort?: AbortController;
  private fileActions = new Set<string>();
  private historyGeneration = 0;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private activeConversation?: {
    id: string;
    sessionId: string;
    root: string;
    provider: ACPLaunch["provider"];
  };
  readonly history: ConversationHistory;
  activity: Activity[] = [];
  subagents = new Map<string, ACPSubagent>();
  activeSubagentCount = 0;
  subagentsTruncated = false;
  selectedSubagent?: string;
  expandedSubagents = new Set<string>();
  subagentsOpen = false;
  title = "New conversation";
  archived = false;
  discovering = false;
  sessions: ACPSessionInfo[] = [];
  nextCursor?: string;
  changes: {
    id: string;
    path: string;
    before: string;
    after: string;
    revision?: string | null;
    undone?: boolean;
    created: boolean;
  }[] = [];
  connection?: ACPConnection;
  launch: ACPLaunch = { provider: "codex" };
  busy = false;
  connecting = false;
  cancelling = false;
  updatingSettings = false;
  error = "";
  status = "Disconnected";
  draft = "";
  messages: Message[] = [];
  requests: AgentRequest[] = [];
  tools = new Map<string, Record<string, any>>();
  terminals = new Map<string, Record<string, any>>();
  plan: { content: string; status: string; priority?: string }[] = [];
  commands: { name: string; description: string }[] = [];
  logs = "";
  context: ACPContext[] = [];
  constructor(readonly options: FeatureOptions) {
    this.history = new ConversationHistory(
      (
        options.workbench as typeof options.workbench & {
          persistence?: Persistence;
        }
      ).persistence,
      `acp-history:${options.filesystem.id}`,
    );
    void this.history.ready.then(() => this.changed());
    const runtime = options.runtime;
    if (!runtime) return;
    const on = (event: string, fn: (params: any) => void) =>
      this.subscriptions.push(
        runtime.subscribe(event, (params) => {
          if (this.disposed) return;
          if (params.id && params.id !== this.connection?.id) return;
          fn(params);
          this.changed();
        }),
      );
    on("acp.update", ({ update, sessionId, rootSessionId }) => {
      if (
        !sessionId ||
        sessionId === (rootSessionId ?? this.connection?.sessionId)
      )
        this.update(update);
    });
    on("acp.subagent", (event: ACPSubagentEvent) => {
      if (
        !this.sessionStarting &&
        event.rootSessionId !== this.connection?.sessionId
      )
        return;
      const mergedIds = event.removedIds.filter((id) =>
        this.subagents
          .get(id)
          ?.toolCallIds.some((tool) =>
            event.subagent.toolCallIds.includes(tool),
          ),
      );
      this.activity = this.activity.flatMap((a) => {
        if (a.kind !== "subagent" || !event.removedIds.includes(a.id))
          return [a];
        return mergedIds.includes(a.id)
          ? [{ kind: "subagent" as const, id: event.subagent.id }]
          : [];
      });
      if (this.selectedSubagent && mergedIds.includes(this.selectedSubagent))
        this.selectedSubagent = event.subagent.id;
      for (const request of this.requests)
        if (request.subagentId && mergedIds.includes(request.subagentId))
          request.subagentId = event.subagent.id;
      for (const id of event.removedIds) this.subagents.delete(id);
      this.subagents.set(event.subagent.id, event.subagent);
      this.activeSubagentCount = event.activeCount;
      this.subagentsTruncated = event.truncated;
      if (
        !event.subagent.parentId &&
        !this.activity.some(
          (a) => a.kind === "subagent" && a.id === event.subagent.id,
        )
      )
        this.activity.push({ kind: "subagent", id: event.subagent.id });
      if (event.subagent.phase === "awaiting_input") {
        this.subagentsOpen = true;
        this.expandAncestors(event.subagent.id);
      }
      if (this.selectedSubagent && !this.subagents.has(this.selectedSubagent))
        this.selectedSubagent = undefined;
    });
    on("acp.log", ({ text }) => {
      this.logs = (this.logs + text).slice(-65536);
    });
    on("acp.terminal", (data) => {
      if (data.subagentId) return;
      this.terminals.set(data.terminalId, data);
      while (this.terminals.size > 32)
        this.terminals.delete(this.terminals.keys().next().value!);
    });
    on("acp.request", (request) => {
      void this.clientRequest(request);
    });
    on("acp.cancelled", () => {
      this.rootRequestGeneration++;
      this.requests = this.requests.filter((r) => this.isChildRequest(r));
    });
    on("acp.requestsExpired", ({ requestIds }) => {
      for (const id of requestIds) {
        const pending = this.pendingClientRequests.get(id);
        if (pending) pending.expired = true;
      }
      this.requests = this.requests.filter(
        (r) => !requestIds.includes(r.requestId),
      );
    });
    on("acp.exit", ({ reason }) => {
      this.clearConnection(reason);
    });
    on("connection.change", ({ state }) => {
      if (state !== "connected") {
        this.clearConnection(
          "Runtime disconnected. Reconnect the agent to start a new conversation.",
        );
      }
    });
    on("workspace.trust", ({ trusted }) => {
      if (!trusted) {
        this.clearConnection("Workspace trust was revoked");
      }
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  changed = () => {
    this.revision++;
    for (const listener of this.listeners) listener();
    if (
      !this.disposed &&
      this.activeConversation &&
      !this.archived &&
      !this.connecting
    ) {
      clearTimeout(this.historyTimer);
      this.historyTimer = setTimeout(() => void this.saveConversation(), 300);
    }
  };
  async saveConversation() {
    clearTimeout(this.historyTimer);
    if (!this.activeConversation || this.archived) return;
    const snapshot = JSON.parse(
      JSON.stringify({
        ...this.activeConversation,
        title: this.title,
        updatedAt: new Date().toISOString(),
        draft: this.draft,
        context: this.context,
        activity: this.activity,
        tools: [...this.tools],
        subagents: [...this.subagents.values()],
        subagentsTruncated: this.subagentsTruncated,
      }),
    ) as Conversation;
    const generation = this.historyGeneration;
    await this.history.ready;
    if (generation !== this.historyGeneration) return;
    await this.history.save(snapshot);
  }
  private resetConversation() {
    this.messages = [];
    this.activity = [];
    this.subagents.clear();
    this.activeSubagentCount = 0;
    this.subagentsTruncated = false;
    this.selectedSubagent = undefined;
    this.expandedSubagents.clear();
    this.subagentsOpen = false;
    this.tools.clear();
    this.terminals.clear();
    this.requests = [];
    this.plan = [];
    this.commands = [];
    this.changes = [];
    this.title = "New conversation";
    this.draft = "";
    this.context = [];
    this.archived = false;
  }
  private get documents() {
    return this.options.documents as DocumentService;
  }
  private clearConnection(status: string) {
    if (this.busy)
      this.activity.push({
        kind: "notice",
        text: "Connection ended during this turn. The prompt was not resent.",
      });
    for (const child of this.subagents.values()) {
      if (
        !child.historical &&
        ["pending", "running", "unknown"].includes(child.state)
      ) {
        child.state = "disconnected";
        child.phase = "unknown";
      }
    }
    this.activeSubagentCount = 0;
    void this.saveConversation();
    this.connectionGeneration++;
    this.requestGeneration++;
    this.startAbort?.abort();
    this.startAbort = undefined;
    this.connection = undefined;
    this.sessionStarting = false;
    this.busy =
      this.connecting =
      this.cancelling =
      this.updatingSettings =
        false;
    this.requests = [];
    this.status = status;
  }
  private request<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ) {
    if (!this.options.runtime?.connected)
      throw new Error("Connect to a runtime workspace first");
    return this.options.runtime.request<T>(method, params);
  }
  async action(fn: () => unknown | Promise<unknown>) {
    this.error = "";
    this.changed();
    try {
      await fn();
    } catch (error) {
      if (!this.disposed)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.changed();
    }
  }
  async connect(launch: ACPLaunch, restore?: Conversation) {
    if (this.disposed || this.connecting || this.connection) return;
    const generation = ++this.connectionGeneration;
    this.connecting = true;
    this.launch = launch;
    this.status = "Connecting…";
    this.logs = "";
    this.changed();
    const abort = new AbortController();
    this.startAbort = abort;
    try {
      if (!this.options.runtime)
        throw new Error("Connect to a runtime workspace first");
      const connection = await this.options.runtime.request<ACPConnection>(
        "acp.start",
        { ...launch },
        { signal: abort.signal },
      );
      if (this.disposed || generation !== this.connectionGeneration) {
        await this.request("acp.stop", { id: connection.id }).catch(() => {});
        return;
      }
      this.connection = connection;
      if (restore && restore.root !== connection.root)
        throw new Error("This conversation belongs to another workspace");
      this.status = "Connected";
      if (restore) await this.restoreConversation(restore);
      else await this.newSession();
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      this.status = this.connection
        ? "Sign in or retry starting the conversation"
        : "Connection failed";
      throw error;
    } finally {
      if (generation === this.connectionGeneration) {
        this.startAbort = undefined;
        this.connecting = false;
        this.changed();
      }
    }
  }
  async call(method: string, params: Record<string, unknown> = {}) {
    if (!this.connection) throw new Error("Connect an agent first");
    return this.request("acp.call", { id: this.connection.id, method, params });
  }
  async newSession() {
    if (this.requests.length)
      throw new Error("Resolve pending requests before changing conversations");
    if (this.activeSubagentCount)
      throw new Error(
        "Wait for active subagents or disconnect before changing conversations",
      );
    const connection = this.connection;
    if (
      !connection ||
      this.busy ||
      this.updatingSettings ||
      this.discovering ||
      this.sessionStarting
    )
      return;
    const generation = this.connectionGeneration;
    this.sessionStarting = true;
    this.connecting = true;
    let previous: Conversation | undefined;
    this.changed();
    try {
      await this.saveConversation();
      previous = this.history.entries.find(
        (e) => e.id === this.activeConversation?.id,
      );
      if (generation !== this.connectionGeneration) return;
      this.resetConversation();
      const result = await this.call("session/new");
      if (generation === this.connectionGeneration) {
        this.connection = result;
        this.activeConversation = {
          id: crypto.randomUUID(),
          sessionId: result.sessionId,
          root: result.root,
          provider: result.provider,
        };
        this.status = "Ready";
      }
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      if (previous) this.restoreSnapshot(previous);
      this.status = "Sign in or retry starting the conversation";
      throw error;
    } finally {
      if (generation === this.connectionGeneration) {
        this.sessionStarting = false;
        this.connecting = false;
        this.changed();
      }
    }
  }
  async authenticate(methodId: string) {
    if (this.connecting || !this.connection) return;
    const generation = this.connectionGeneration;
    this.connecting = true;
    this.changed();
    try {
      await this.call("authenticate", { methodId });
      if (generation !== this.connectionGeneration) return;
      if (!this.connection?.sessionId) await this.newSession();
    } catch (error) {
      if (generation === this.connectionGeneration) throw error;
    } finally {
      if (generation === this.connectionGeneration) {
        this.connecting = false;
        this.changed();
      }
    }
  }
  async disconnect() {
    const connection = this.connection;
    const saved = this.saveConversation();
    this.clearConnection("Disconnected");
    const generation = this.connectionGeneration;
    this.changed();
    try {
      if (connection && this.options.runtime?.connected)
        await this.request("acp.stop", { id: connection.id });
      await saved;
    } catch (error) {
      if (generation === this.connectionGeneration) throw error;
    }
  }
  async discover(more = false) {
    if (
      !this.connection ||
      this.busy ||
      this.connecting ||
      this.discovering ||
      this.updatingSettings
    )
      return;
    const generation = this.connectionGeneration;
    this.discovering = true;
    this.changed();
    try {
      const result = await this.call(
        "session/list",
        more && this.nextCursor ? { cursor: this.nextCursor } : {},
      );
      if (generation !== this.connectionGeneration) return;
      this.sessions = [
        ...new Map(
          [...(more ? this.sessions : []), ...result.sessions].map((s) => [
            s.sessionId,
            s,
          ]),
        ).values(),
      ] as ACPSessionInfo[];
      this.nextCursor =
        result.nextCursor === this.nextCursor && more
          ? undefined
          : result.nextCursor;
    } finally {
      if (generation === this.connectionGeneration) {
        this.discovering = false;
        this.changed();
      }
    }
  }
  async viewConversation(entry: Conversation) {
    if (this.requests.length)
      throw new Error("Resolve pending requests before changing conversations");
    if (this.activeSubagentCount)
      throw new Error(
        "Wait for active subagents or disconnect before changing conversations",
      );
    if (
      this.busy ||
      this.connecting ||
      this.updatingSettings ||
      this.discovering
    )
      return;
    await this.disconnect();
    this.restoreSnapshot(entry);
    this.archived = true;
    this.status = "Saved conversation";
    this.changed();
  }
  async forgetConversation(id: string) {
    this.historyGeneration++;
    if (this.activeConversation?.id === id) {
      clearTimeout(this.historyTimer);
      this.activeConversation = undefined;
    }
    await this.history.ready;
    await this.history.remove(id);
  }
  private restoreSnapshot(entry: Conversation) {
    this.resetConversation();
    const copy = JSON.parse(JSON.stringify(entry)) as Conversation;
    this.activeConversation = {
      id: copy.id,
      sessionId: copy.sessionId,
      root: copy.root,
      provider: copy.provider,
    };
    this.title = copy.title;
    this.draft = copy.draft;
    this.context = copy.context;
    this.activity = copy.activity;
    this.tools = new Map(copy.tools);
    this.subagents = new Map(
      (copy.subagents ?? []).map((child) => [
        child.id,
        { ...child, historical: true },
      ]),
    );
    this.subagentsTruncated = copy.subagentsTruncated ?? false;
    this.messages = this.activity.flatMap((a) =>
      a.kind === "message" ? [a.message] : [],
    );
  }
  async resumeSaved(entry: Conversation) {
    if (this.requests.length)
      throw new Error("Resolve pending requests before changing conversations");
    if (this.activeSubagentCount)
      throw new Error(
        "Wait for active subagents or disconnect before changing conversations",
      );
    if (
      this.busy ||
      this.connecting ||
      this.updatingSettings ||
      this.discovering
    )
      return;
    if (
      this.connection?.provider === entry.provider &&
      this.connection.root === entry.root
    )
      return this.restoreConversation(entry);
    await this.disconnect();
    const preset = providerFor(entry.provider);
    const config = this.options.kernel.configuration;
    const command =
      config.get<string>(`agentACP.${entry.provider}.command`) ||
      preset.command;
    const args = JSON.parse(
      config.get<string>(`agentACP.${entry.provider}.args`) ||
        JSON.stringify(preset.args),
    );
    await this.connect({ provider: entry.provider, command, args }, entry);
  }
  async restoreConversation(entry: Conversation) {
    if (this.requests.length)
      throw new Error("Resolve pending requests before changing conversations");
    if (this.activeSubagentCount)
      throw new Error(
        "Wait for active subagents or disconnect before changing conversations",
      );
    if (
      !this.connection ||
      this.busy ||
      this.updatingSettings ||
      this.discovering ||
      this.sessionStarting
    )
      return;
    if (
      entry.root !== this.connection.root ||
      entry.provider !== this.connection.provider
    )
      throw new Error(
        "This conversation belongs to another workspace or provider",
      );
    const capabilities = this.connection.capabilities;
    const method = capabilities?.loadSession
      ? "session/load"
      : capabilities?.sessionCapabilities?.resume
        ? "session/resume"
        : undefined;
    if (!method)
      throw new Error(
        "This agent cannot resume conversations. You can still read the saved transcript.",
      );
    this.sessionStarting = this.connecting = true;
    const generation = this.connectionGeneration;
    await this.saveConversation();
    if (generation !== this.connectionGeneration) return;
    const previous =
      this.activeConversation &&
      this.history.entries.find((e) => e.id === this.activeConversation!.id);
    this.restoreSnapshot(entry);
    if (method === "session/load") {
      this.activity = [];
      this.messages = [];
      this.tools.clear();
    }
    this.sessionStarting = this.connecting = true;
    this.status = "Restoring conversation…";
    this.changed();
    try {
      const result = await this.call(method, { sessionId: entry.sessionId });
      if (generation !== this.connectionGeneration) return;
      this.connection = result;
      this.status = "Ready";
      this.archived = false;
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      if (previous) this.restoreSnapshot(previous);
      else {
        this.restoreSnapshot(entry);
        this.archived = true;
      }
      this.status = "Conversation could not be restored";
      throw error;
    } finally {
      if (generation === this.connectionGeneration) {
        this.sessionStarting = this.connecting = false;
        this.changed();
      }
    }
  }
  importConversation(entry: ACPSessionInfo) {
    const connection = this.connection!;
    const existing = this.history.entries.find(
      (e) =>
        e.sessionId === entry.sessionId &&
        e.provider === connection.provider &&
        e.root === entry.cwd,
    );
    if (existing) return this.restoreConversation(existing);
    return this.restoreConversation({
      id: crypto.randomUUID(),
      ...entry,
      root: entry.cwd,
      provider: connection.provider,
      title: entry.title || "Saved conversation",
      updatedAt: entry.updatedAt || new Date().toISOString(),
      draft: "",
      context: [],
      activity: [],
      tools: [],
    });
  }
  async setSessionControl(control: SessionControl, value: string) {
    if (
      this.busy ||
      this.connecting ||
      this.updatingSettings ||
      this.discovering ||
      this.archived
    )
      return;
    const connection = this.connection;
    if (!connection?.sessionId) throw new Error("Start a conversation first");
    const current = sessionControls(connection).find(
      (item) => item.id === control.id && item.method === control.method,
    );
    if (!current?.options.some((option) => option.value === value))
      throw new Error("This agent setting is no longer available");
    if (current.value === value) return;
    const generation = this.connectionGeneration;
    this.updatingSettings = true;
    this.changed();
    try {
      const params =
        control.method === "session/set_config_option"
          ? { configId: control.id, value }
          : control.method === "session/set_mode"
            ? { modeId: value }
            : { modelId: value };
      const result = await this.call(control.method, params);
      if (generation !== this.connectionGeneration) return;
      if (result?.configOptions)
        connection.configOptions = result.configOptions;
      else if (control.method === "session/set_config_option") {
        const config = connection.configOptions?.find(
          (item) => item.id === control.id,
        );
        if (config) config.currentValue = value;
      }
      if (control.method === "session/set_mode" && connection.modes)
        connection.modes.currentModeId = value;
      if (control.method === "session/set_model" && connection.models)
        connection.models.currentModelId = value;
    } catch (error) {
      if (generation === this.connectionGeneration) throw error;
    } finally {
      if (generation === this.connectionGeneration) {
        this.updatingSettings = false;
        this.changed();
      }
    }
  }
  attach(selection = false) {
    const path = this.options.workbench.activePath();
    if (!path) throw new Error("Open a file to attach context");
    const doc = this.documents.get(path);
    if (!doc) throw new Error("The active file is unavailable");
    const editor = this.options.workbench.activeEditor();
    const range = editor?.state?.selection?.main;
    if (selection && (!range || range.empty))
      throw new Error("Select text in the editor first");
    const text = selection
      ? doc.text.toString().slice(range.from, range.to)
      : doc.text.toString();
    if (text.length > 200000)
      throw new Error(
        "Select a smaller portion of this file (maximum 200,000 characters)",
      );
    if (this.context.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    const line = selection
      ? doc.text.toString().slice(0, range.from).split("\n").length
      : undefined;
    const endLine = selection
      ? doc.text
          .toString()
          .slice(0, Math.max(range.from, range.to - 1))
          .split("\n").length
      : undefined;
    this.context.push({
      path,
      text,
      line,
      endLine,
      version: doc.version,
      kind: selection ? "selection" : "file",
      label: path + (selection ? `:${line}-${endLine}` : ""),
    });
    this.changed();
  }
  async attachPath(path: string) {
    const document = await this.documents.open(path);
    if (this.context.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    const text = document.text.toString();
    if (text.length > 200000)
      throw new Error(
        "Select a smaller portion of this file (maximum 200,000 characters)",
      );
    this.context.push({
      path,
      text,
      label: path,
      kind: "file",
      version: document.version,
    });
    this.changed();
  }
  attachDiagnostics() {
    const path = this.options.workbench.activePath();
    if (!path) throw new Error("Open a file to attach its diagnostics");
    const language = this.options.kernel.services.get<any>("language");
    const diagnostics = language?.diagnostics?.get(path) ?? [];
    if (!diagnostics.length)
      throw new Error("No diagnostics for the active file");
    if (this.context.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    const text = diagnostics
      .map(
        (d: any) =>
          `${path}:${(d.range?.start?.line ?? 0) + 1}:${(d.range?.start?.character ?? 0) + 1} ${d.source ? `[${d.source}] ` : ""}${d.message}`,
      )
      .join("\n");
    if (text.length > 200000) throw new Error("Too many diagnostics to attach");
    this.context.push({
      path,
      text,
      kind: "diagnostics",
      label: `Diagnostics: ${path}`,
    });
    this.changed();
  }
  async send() {
    if (
      this.busy ||
      this.connecting ||
      this.updatingSettings ||
      this.discovering ||
      this.archived ||
      !this.draft.trim()
    )
      return;
    const prompt = this.draft.trim();
    const context = this.context.map((c) => ({ ...c }));
    if (JSON.stringify({ prompt, context }).length > 1000000)
      throw new Error("The message and attachments are too large");
    if (!this.connection?.sessionId)
      throw new Error("Start a conversation first");
    const message: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: prompt,
      context,
    };
    this.messages.push(message);
    this.activity.push({ kind: "message", message });
    if (this.title === "New conversation") this.title = prompt.slice(0, 100);
    this.draft = "";
    this.context = [];
    this.busy = true;
    this.status = "Working…";
    const generation = this.connectionGeneration;
    this.changed();
    try {
      const result = await this.call("session/prompt", {
        text: prompt,
        ...(context.length ? { context } : {}),
      });
      if (generation !== this.connectionGeneration) return;
      this.status = result?.stopReason === "cancelled" ? "Stopped" : "Ready";
      if (result?.stopReason && result.stopReason !== "end_turn")
        this.activity.push({
          kind: "notice",
          text: `Turn ended: ${result.stopReason}`,
        });
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      this.status = "Turn failed";
      this.activity.push({
        kind: "notice",
        text: "Turn failed. Review the error before retrying.",
      });
      if (!this.draft) {
        this.draft = prompt;
        this.context = context;
      }
      throw error;
    } finally {
      if (generation === this.connectionGeneration) {
        this.busy = this.cancelling = false;
        this.rootRequestGeneration++;
        this.requests = this.requests.filter((r) => this.isChildRequest(r));
        this.changed();
        await this.saveConversation();
      }
    }
  }
  async cancel() {
    if (this.connection && !this.busy && this.activeSubagentCount)
      return this.disconnect();
    if (this.connection && this.busy && !this.cancelling) {
      const generation = this.connectionGeneration;
      this.cancelling = true;
      this.status = "Stopping…";
      this.changed();
      try {
        await this.request("acp.cancel", { id: this.connection.id });
      } catch (error) {
        if (generation !== this.connectionGeneration) return;
        this.cancelling = false;
        if (this.busy) this.status = "Working…";
        this.changed();
        throw error;
      }
    }
  }
  private update(update: Record<string, any>) {
    if (!update) return;
    if (
      [
        "agent_message_chunk",
        "agent_thought_chunk",
        "user_message_chunk",
      ].includes(update.sessionUpdate)
    ) {
      const role =
        update.sessionUpdate === "agent_thought_chunk"
          ? "thought"
          : update.sessionUpdate === "user_message_chunk"
            ? "user"
            : "agent";
      const text =
        update.content?.text ??
        update.content?.resource?.text ??
        (update.content?.type ? `[${update.content.type} content]` : "");
      const previous = this.activity.at(-1);
      const last = previous?.kind === "message" ? previous.message : undefined;
      if (
        last?.role === role &&
        (!update.messageId || last.id === update.messageId)
      )
        last.text = (last.text + text).slice(-250000);
      else {
        const message: Message = {
          role,
          text,
          id: update.messageId || crypto.randomUUID(),
        };
        this.messages.push(message);
        this.activity.push({ kind: "message", message });
      }
      while (this.messages.length > 100) this.messages.shift();
    } else if (
      ["tool_call", "tool_call_update"].includes(update.sessionUpdate)
    ) {
      if (!this.tools.has(update.toolCallId))
        this.activity.push({ kind: "tool", id: update.toolCallId });
      this.tools.set(update.toolCallId, {
        ...this.tools.get(update.toolCallId),
        ...update,
      });
      while (this.tools.size > 100)
        this.tools.delete(this.tools.keys().next().value!);
    } else if (
      update.sessionUpdate === "session_info_update" &&
      typeof update.title === "string"
    )
      this.title = update.title.slice(0, 200);
    else if (update.sessionUpdate === "plan") this.plan = update.entries ?? [];
    else if (update.sessionUpdate === "available_commands_update")
      this.commands = update.availableCommands ?? [];
    else if (
      update.sessionUpdate === "current_mode_update" &&
      this.connection?.modes
    )
      this.connection.modes.currentModeId = update.currentModeId;
    else if (update.sessionUpdate === "config_option_update" && this.connection)
      this.connection.configOptions = update.configOptions;
    else if (update.sessionUpdate === "cursor/update_todos")
      this.plan = update.todos ?? [];
    else if (update.sessionUpdate?.startsWith("cursor/"))
      this.logs = (this.logs + "\n" + JSON.stringify(update)).slice(-65536);
    while (this.activity.length > 200) this.activity.shift();
  }
  private async clientRequest(request: AgentRequest) {
    const pending = { expired: false };
    this.pendingClientRequests.set(request.requestId, pending);
    const generation = this.requestGeneration;
    const rootGeneration = this.rootRequestGeneration;
    const valid = () =>
      !pending.expired &&
      generation === this.requestGeneration &&
      (this.isChildRequest(request) ||
        rootGeneration === this.rootRequestGeneration);
    try {
      if (request.method === "fs/read_text_file") {
        const document = await this.documents.open(request.params.path);
        const text = document.text.toString();
        const start = (request.params.line ?? 1) - 1;
        const content =
          request.params.line !== undefined ||
          request.params.limit !== undefined
            ? text
                .split("\n")
                .slice(
                  start,
                  request.params.limit
                    ? start + request.params.limit
                    : undefined,
                )
                .join("\n")
            : text;
        if (valid()) await this.respond(request, { content });
        return;
      }
      if (request.method === "fs/write_text_file") {
        let document;
        try {
          document = await this.documents.open(request.params.path);
        } catch (error) {
          if (
            (error as any)?.code !== "ENOENT" &&
            (error as any)?.code !== "NOT_FOUND"
          )
            throw error;
        }
        if (document?.dirty)
          throw new Error(
            `Save or revert your unsaved edits in ${request.params.path} before the agent can replace the file.`,
          );
        if (document && document.state !== "ready")
          throw new Error(
            `Resolve the file's ${document.state} state before applying agent changes.`,
          );
        request.before = document?.text.toString() ?? "";
        request.revision = document?.savedRevision ?? null;
        request.version = document?.version;
      }
      if (!this.disposed && valid() && this.connection?.id === request.id) {
        this.requests.push(request);
        this.changed();
      }
    } catch (error) {
      if (this.disposed || !valid()) return;
      await this.respond(request, undefined, String(error)).catch(() => {});
      this.error = String(error);
      this.changed();
    } finally {
      if (this.pendingClientRequests.get(request.requestId) === pending)
        this.pendingClientRequests.delete(request.requestId);
    }
  }
  async respond(request: AgentRequest, result?: unknown, error?: string) {
    await this.request("acp.respond", {
      id: request.id,
      requestId: request.requestId,
      result,
      error,
    });
    this.requests = this.requests.filter(
      (r) => r.requestId !== request.requestId,
    );
    this.changed();
  }
  async applyFile(request: AgentRequest) {
    if (!this.requests.includes(request) || this.connection?.id !== request.id)
      throw new Error("File review has expired");
    if (this.fileActions.has(request.requestId)) return;
    const document = this.documents.get(request.params.path);
    if (
      document?.dirty ||
      (request.version !== undefined &&
        (document?.version !== request.version ||
          document.savedRevision !== request.revision)) ||
      (request.revision === null && document)
    ) {
      await this.respond(
        request,
        undefined,
        "File changed during review. Read the latest content and retry.",
      );
      return;
    }
    this.fileActions.add(request.requestId);
    try {
      if (document) {
        // Update the shared document before saving: collaborative saves persist
        // the Yjs room, not a standalone text argument passed to the filesystem.
        document.replace(request.params.content);
        await this.documents.save(request.params.path, undefined, {
          skipHooks: true,
        });
      } else {
        await this.options.filesystem.write(
          request.params.path,
          request.params.content,
          { expectedRevision: null },
        );
      }
      const saved = this.documents.get(request.params.path);
      this.changes.push({
        id: crypto.randomUUID(),
        path: request.params.path,
        before: request.before ?? "",
        after: request.params.content,
        revision: saved?.savedRevision,
        created: request.revision === null,
      });
      while (this.changes.length > 30) this.changes.shift();
      this.activity.push({
        kind: "notice",
        text: `Applied change: ${request.params.path}`,
      });
      await this.respond(request, null);
      await this.options.workbench.openFile(request.params.path, {
        preview: false,
      });
      await this.options.workbench.refreshFiles();
    } catch (error) {
      await this.respond(request, undefined, String(error)).catch(() => {});
      throw error;
    } finally {
      this.fileActions.delete(request.requestId);
    }
  }
  async undoChange(id: string) {
    const change = this.changes.find((c) => c.id === id);
    if (!change || change.undone)
      throw new Error("This change is no longer available to undo");
    if (
      this.busy ||
      this.connecting ||
      this.requests.length ||
      this.activeSubagentCount
    )
      throw new Error("Wait for the agent to finish before undoing changes");
    if (change.created)
      throw new Error("Review newly created files in Source Control");
    if (this.fileActions.has(id)) return;
    this.fileActions.add(id);
    try {
      const doc = await this.documents.open(change.path);
      const version = doc.version;
      const unchanged = () =>
        !doc.dirty &&
        doc.state === "ready" &&
        doc.text.toString() === change.after &&
        doc.savedRevision === change.revision;
      if (!unchanged())
        throw new Error(
          "This file changed after the agent edit. Review it in Source Control to preserve newer work.",
        );
      const disk = await this.options.filesystem.read(change.path);
      if (disk.text !== change.after || disk.revision !== change.revision)
        throw new Error("This file changed on disk after the agent edit");
      if (
        !unchanged() ||
        doc.version !== version ||
        this.busy ||
        this.connecting ||
        this.activeSubagentCount
      )
        throw new Error("The editor changed while checking this undo");
      doc.replace(change.before);
      await this.documents.save(change.path, undefined, { skipHooks: true });
      change.undone = true;
      this.activity.push({
        kind: "notice",
        text: `Undid agent change: ${change.path}`,
      });
    } finally {
      this.fileActions.delete(id);
      this.changed();
    }
  }

  private isChildRequest(request: AgentRequest) {
    return (
      !!request.sessionId &&
      request.sessionId !==
        (request.rootSessionId ?? this.connection?.sessionId)
    );
  }
  expandAncestors(id: string) {
    const seen = new Set<string>();
    let parent = this.subagents.get(id)?.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      this.expandedSubagents.add(parent);
      parent = this.subagents.get(parent)?.parentId;
    }
  }
  selectSubagent(id: string) {
    if (!this.subagents.has(id)) return;
    this.selectedSubagent = id;
    this.subagentsOpen = true;
    this.expandAncestors(id);
    this.changed();
  }
  toggleSubagent(id: string) {
    if (this.expandedSubagents.has(id)) {
      this.expandedSubagents.delete(id);
      const seen = new Set<string>();
      let parent = this.subagents.get(this.selectedSubagent ?? "")?.parentId;
      while (parent && !seen.has(parent)) {
        if (parent === id) {
          this.selectedSubagent = id;
          break;
        }
        seen.add(parent);
        parent = this.subagents.get(parent)?.parentId;
      }
    } else this.expandedSubagents.add(id);
    this.changed();
  }
  openAgents(id?: string) {
    if (id) this.selectSubagent(id);
    this.options.workbench.openPanel("agent-acp-agents");
  }
  async openLocation(absolute: string, line?: number) {
    const root = this.connection?.root ?? this.activeConversation?.root;
    if (!root) return;
    const path = absolute.startsWith(root + "/")
      ? absolute.slice(root.length + 1)
      : absolute;
    if (path.startsWith("/") || path.split("/").includes(".."))
      throw new Error("This file is outside the workspace");
    await this.options.workbench.openFile(path, {
      line: line === undefined ? undefined : line + 1,
      preview: false,
    });
  }
  dispose() {
    void this.saveConversation();
    clearTimeout(this.historyTimer);
    this.disposed = true;
    this.clearConnection("Disconnected");
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    this.listeners.clear();
    if (this.options.runtime?.connected)
      void this.request("acp.disconnect").catch(() => {});
    this.connection = undefined;
    this.requests = [];
  }
}
export const providerFor = (id: string) =>
  ACP_PROVIDERS.find((provider) => provider.id === id) ?? ACP_PROVIDERS[0];
