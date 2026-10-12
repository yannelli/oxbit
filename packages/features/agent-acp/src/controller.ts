import {
  ACP_CUSTOM_PROVIDER,
  AGENT_MODELS_SERVICE,
  OXBIT_AGENT_PROVIDER,
  OXBIT_AGENT_SETTINGS,
  OXBIT_CLI_PROVIDER,
  acpPreset,
  type ACPConnection,
  type ACPRegistryListing,
  type ACPLaunch,
  type ACPContext,
  type ACPQueuedPrompt,
  type ACPLiveSession,
  type ACPSessionSnapshot,
  type ACPSessionInfo,
  type ACPSubagent,
  type ACPSubagentEvent,
  type AgentModels,
  type FeatureOptions,
  type GitLog,
} from "@oxbit/sdk";
import type { DocumentService } from "@oxbit/documents";
import { sessionControls, type SessionControl } from "./session-controls.js";
import type { Persistence } from "@oxbit/sdk";
import {
  ConversationHistory,
  type Activity,
  type Conversation,
  type Message,
  type PlanEntry,
  type SavedLaunch,
} from "./history.js";
import {
  agentName,
  launchName,
  rememberAgentName,
  rememberRegistryName,
  resolveLaunch,
  runtimeSupportError,
} from "./launch.js";
import { AGENT_VIEW, Attention } from "./attention.js";
import { AGENT_LIMIT_STATUS, agentLimit, backgroundRequests } from "./threads.js";
import { oxbitEndpoint, settingId } from "./configuration.js";
import { generateTitle } from "./local/title.js";
export type { Message } from "./history.js";
import { encodeImage, imageContext, imageError, withoutImageData } from "./images.js";
import { branchChanges, commitChanges, uncommittedChanges } from "./changes.js";
import {
  forkContext, searchCommits, searchThreads, threadTranscript, type CommitMention, type Mention, type SymbolMention,
} from "./mentions.js";
import { folderText } from "./folders.js";
import { Checkpoints, carryCheckpoints, restoredNotice } from "./checkpoints.js";

const FORKED_NOTICE = "Forked from “{title}”. The agent keeps the earlier context.";
/** The in-app agent has no snapshot store, so the panel runs `/undo` through the review card's undo. */
const UNDO_COMMAND = { name: "undo", description: "Undo the agent's edits from the latest turn" };

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
export const FILE_REJECTED = "User rejected the file change";
/** Oxbit agents mark writes made in the accept-edits and full-auto modes that the user picked in this panel. */
const modeApplies = (provider: string | undefined, params: { _meta?: { oxbit?: { mode?: unknown } } } | undefined) =>
  (provider === OXBIT_AGENT_PROVIDER || provider === OXBIT_CLI_PROVIDER) && ["accept-edits", "full-auto"].includes(params?._meta?.oxbit?.mode as string);
const missingFile = (error: unknown) =>
  ["ENOENT", "NOT_FOUND"].includes((error as { code?: unknown } | null)?.code as string) ||
  (error instanceof DOMException && error.name === "NotFoundError") ||
  (error instanceof Error && /^File not found:/.test(error.message));

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
  private eventHandlers = new Map<string, (params: any) => void>();
  private attachBuffer?: { name: string; params: any }[];
  private lastSequence = 0;
  private queueRevision = 0;
  private activeTurnId?: string;
  private activeConversation?: {
    id: string;
    sessionId: string;
    root: string;
    provider: ACPLaunch["provider"];
    name?: string;
    launch?: SavedLaunch;
  };
  private replaying = false;
  private threadConversations = new Map<string, string>();
  /** The runtime connection to reattach when the runtime reconnects, while its conversation stays open. */
  private reattachOnReconnect?: { id: string; conversationId?: string };
  private reconnects: number[] = [];
  private checkpointing = false;
  private autoApplyValue?: boolean;
  private titleRequested = false;
  private agentTitled = false;
  readonly attention: Attention;
  readonly checkpoints: Checkpoints;
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
    turn?: string;
  }[] = [];
  connection?: ACPConnection;
  launch: ACPLaunch = { provider: "codex" };
  /** The launch used when Connect or the next message starts an agent. */
  selection?: ACPLaunch;
  registry?: ACPRegistryListing;
  registryLoading = false;
  private busyValue = false;
  /** When the current turn started; the Working row reads it so remounts keep the elapsed time. */
  turnStartedAt?: number;
  get busy() {
    return this.busyValue;
  }
  set busy(value: boolean) {
    if (value !== this.busyValue) this.turnStartedAt = value ? Date.now() : undefined;
    this.busyValue = value;
  }
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
  commands: { name: string; description: string }[] = [];
  logs = "";
  context: ACPContext[] = [];
  queue: ACPQueuedPrompt[] = [];
  queuePaused = false;
  liveSessions: ACPLiveSession[] = [];
  replayTruncated = false;
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
  constructor(readonly options: FeatureOptions) {
    this.history = new ConversationHistory(
      (
        options.workbench as typeof options.workbench & {
          persistence?: Persistence;
        }
      ).persistence,
      `acp-history:${options.filesystem.id}`,
    );
    this.attention = new Attention(options);
    this.checkpoints = new Checkpoints(async (method, params) => this.request(method, params), this.changed, () => this.messages);
    void this.history.ready.then(() => {
      for (const entry of this.history.entries)
        if (!acpPreset(entry.provider)) rememberAgentName(entry.provider, entry.name);
      this.changed();
    });
    const runtime = options.runtime;
    if (!runtime) return;
    const on = (event: string, fn: (params: any) => void) => {
      this.eventHandlers.set(event, fn);
      this.subscriptions.push(runtime.subscribe(event, (params) => {
        if (this.attachBuffer && event !== "connection.change" && event !== "workspace.trust") {
          this.attachBuffer.push({ name: event, params });
          return;
        }
        this.deliver(event, params);
      }));
    };
    on("acp.turnStarted", ({ messageId, text, context }) => {
      if (!messageId) return;
      this.activeTurnId = messageId;
      if (!this.messages.some(message => message.id === messageId)) {
        const message: Message = { id: messageId, role: "user", text, context };
        this.messages.push(message);
        this.activity.push({ kind: "message", message });
        if (!this.replaying)
          void this.checkpoints.create().then((tree) => { if (tree) { message.checkpoint = tree; this.changed(); } });
      }
      if (this.title === "New conversation") this.title = text.slice(0, 100);
      this.busy = true;
      this.cancelling = false;
      this.status = "Working…";
    });
    on("acp.turnEnded", ({ stopReason, error }) => {
      this.activeTurnId = undefined;
      this.busy = this.cancelling = false;
      this.rootRequestGeneration++;
      this.requests = this.requests.filter(request => this.isChildRequest(request));
      this.status = error ? "Turn failed" : stopReason === "cancelled" ? "Stopped" : "Ready";
      if (error) this.error = String(error);
      if (!this.replaying && stopReason !== "cancelled")
        this.attention.turnEnded(this.title, !!error);
      if (!this.replaying && !error && stopReason !== "cancelled") void this.nameConversation();
    });
    on("acp.queue", ({ queue, paused }) => {
      this.queueRevision++;
      this.queue = queue ?? [];
      this.queuePaused = paused === true;
    });
    on("acp.attachedElsewhere", () => this.clearConnection("Opened in another window", true));
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
    on("acp.exit", ({ reason, unexpected }) => {
      const target = unexpected === true ? this.reconnectTarget() : undefined;
      this.clearConnection(reason);
      if (target) void this.action(() => this.reconnect(target, reason));
    });
    on("connection.change", ({ state }) => {
      if (state === "connected") {
        const target = this.reattachOnReconnect;
        this.reattachOnReconnect = undefined;
        if (target && !this.connection && this.activeConversation?.id === target.conversationId) {
          if (target.conversationId) this.threadConversations.set(target.id, target.conversationId);
          void this.attachLive(target.id).catch(() => this.changed());
        }
        return;
      }
      const id = this.local ? undefined : this.connection?.id;
      const conversationId = this.activeConversation?.id;
      this.liveSessions = [];
      this.clearConnection(
        "Runtime disconnected. Open Runtime sessions after reconnecting to reattach.", true,
      );
      if (id) this.reattachOnReconnect = { id, conversationId };
    });
    on("workspace.trust", ({ trusted }) => {
      if (!trusted) {
        this.clearConnection("Workspace trust was revoked");
      }
    });
  }
  private deliver(name: string, params: any) {
    if (this.disposed) return;
    if (params.id && params.id !== this.connection?.id) return;
    if (typeof params.seq === "number") {
      if (params.seq <= this.lastSequence) return;
      this.lastSequence = params.seq;
    }
    this.eventHandlers.get(name)?.(params);
    this.changed();
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
    if (!this.disposed) {
      const pending = this.requests.length + backgroundRequests(this.liveSessions, this.connection?.id);
      this.attention.sync(pending, () => ({
        agent: launchName(this.launch),
        title: this.title,
        connected: !!this.connection,
        busy: this.busy,
        startedAt: this.turnStartedAt,
        pending,
        tool: this.latestToolTitle(),
      }));
    }
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
        context: this.context.filter((item) => item.kind !== "image"),
        activity: this.activity,
        tools: [...this.tools],
        subagents: [...this.subagents.values()],
        subagentsTruncated: this.subagentsTruncated,
        autoApplyEdits: this.autoApply,
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
    this.commands = [];
    this.changes = [];
    this.title = "New conversation";
    this.draft = "";
    this.context = [];
    this.queue = [];
    this.queuePaused = false;
    this.replayTruncated = false;
    this.usage = undefined;
    this.lastSequence = 0;
    this.queueRevision = 0;
    this.activeTurnId = undefined;
    this.archived = false;
    this.autoApplyValue = undefined;
    this.titleRequested = this.agentTitled = false;
  }
  /** Agent writes apply without review. A conversation keeps the value it started with or the user chose. */
  get autoApply() {
    return this.autoApplyValue ?? this.options.kernel.configuration?.get<boolean>("agentACP.autoApplyEdits") === true;
  }
  setAutoApply(value: boolean) {
    this.autoApplyValue = value;
    this.changed();
  }
  private get documents() {
    return this.options.documents as DocumentService;
  }
  private clearConnection(status: string, retained = false) {
    if (this.busy)
      this.activity.push({
        kind: "notice",
        text: retained ? "The runtime kept this turn. Reattach to follow it." : "The agent turn ended.",
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
    this.queue = [];
    this.queuePaused = false;
    this.activeTurnId = undefined;
    this.status = status;
  }
  /** The open conversation to load into a new agent process after a crash, at most 3 times a minute. */
  private reconnectTarget() {
    const conversation = this.activeConversation;
    if (this.archived || !conversation?.sessionId || !this.connection?.capabilities?.loadSession) return undefined;
    const now = Date.now();
    this.reconnects = this.reconnects.filter((time) => now - time < 60000);
    if (this.reconnects.length >= 3) return undefined;
    this.reconnects.push(now);
    const prompt = this.busy ? this.messages.findLast((message) => message.role === "user")?.text : undefined;
    return { id: conversation.id, launch: this.launch, prompt };
  }
  /** Starts the agent again and loads the conversation. A prompt the replay lacks returns to an empty composer. */
  private async reconnect(target: { id: string; launch: ACPLaunch; prompt?: string }, reason: string) {
    await this.saveConversation();
    const entry = this.history.entries.find((e) => e.id === target.id);
    if (!entry || this.disposed || this.connection || this.connecting || this.activeConversation?.id !== target.id) return;
    this.status = "Reconnecting…";
    this.changed();
    await this.connect(target.launch, entry);
    if (this.activeConversation?.id !== target.id || !this.connection) return;
    this.activity.push({ kind: "notice", text: `${reason}. The agent restarted and loaded this conversation.` });
    if (target.prompt && !this.draft.trim() && this.messages.findLast((message) => message.role === "user")?.text !== target.prompt)
      this.draft = target.prompt;
    void this.saveConversation();
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
      if (!this.options.runtime || (this.localRuntime && !this.local))
        throw new Error("Connect to a runtime workspace first");
      const connection = await this.options.runtime.request<ACPConnection>(
        "acp.start",
        { ...launch, clientCapabilities: { editorTools: true } },
        { signal: abort.signal },
      );
      if (this.disposed || generation !== this.connectionGeneration) {
        await this.request("acp.stop", { id: connection.id }).catch(() => {});
        return;
      }
      this.connection = connection;
      rememberAgentName(connection.provider, connection.name ?? launch.name);
      if (restore && restore.root !== connection.root)
        throw new Error("This conversation belongs to another workspace");
      this.status = "Connected";
      if (restore) await this.restoreConversation(restore);
      else await this.newSession();
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      const limited = !this.connection && agentLimit(error);
      this.status = this.connection
        ? "Sign in or retry starting the conversation"
        : limited ? AGENT_LIMIT_STATUS : "Connection failed";
      if (limited) void this.listLiveSessions().catch(() => {});
      throw this.connection ? error : runtimeSupportError(error, launchName(launch));
    } finally {
      if (generation === this.connectionGeneration) {
        this.startAbort = undefined;
        this.connecting = false;
        this.changed();
      }
    }
  }
  async connectSelected() {
    await this.connect(resolveLaunch(this.chosen, this.options.kernel.configuration));
  }
  private get localRuntime() {
    return (this.options.runtime as { local?: boolean } | undefined)?.local === true;
  }
  /** True when the session has no runtime workspace and the host provides the Oxbit agent's model service. */
  get local() {
    return this.localRuntime && !!this.options.runtime?.connected;
  }
  /** The selection, or the persisted default agent. The Oxbit agent serves local workspaces only. */
  get chosen(): ACPLaunch {
    if (this.local) return { provider: OXBIT_AGENT_PROVIDER };
    const chosen = this.selection ?? {
      provider: this.options.kernel.configuration?.get<string>("agentACP.provider") || "codex",
    };
    return chosen.provider === OXBIT_AGENT_PROVIDER ? { provider: "codex" } : chosen;
  }
  /** Label for the live connection, or for the agent Connect would start. */
  get displayName() {
    return this.connection
      ? agentName(this.connection.provider, this.connection)
      : launchName(resolveLaunch(this.chosen, this.options.kernel.configuration));
  }
  async select(launch: ACPLaunch) {
    const config = this.options.kernel.configuration;
    if (launch.provider === ACP_CUSTOM_PROVIDER) {
      await config.set(settingId(ACP_CUSTOM_PROVIDER, "name"), launch.name ?? "", "user");
      await config.set(settingId(ACP_CUSTOM_PROVIDER, "command"), launch.command ?? "", "user");
      await config.set(settingId(ACP_CUSTOM_PROVIDER, "args"), JSON.stringify(launch.args ?? []), "user");
    }
    if (launch.provider !== OXBIT_AGENT_PROVIDER)
      await config.set("agentACP.provider", launch.provider, "user");
    this.selection = launch;
    this.changed();
  }
  async loadRegistry() {
    if (this.registryLoading) return;
    this.registryLoading = true;
    this.changed();
    try {
      const listing = await this.request<ACPRegistryListing>("acp.registry");
      for (const agent of listing.agents) rememberRegistryName(agent.id, agent.name);
      this.registry = listing;
    } finally {
      this.registryLoading = false;
      this.changed();
    }
  }
  markSeen() {
    this.attention.seen();
    this.changed();
  }
  private savedLaunch(launch: ACPLaunch): SavedLaunch | undefined {
    if (launch.provider === ACP_CUSTOM_PROVIDER)
      return { name: launch.name, command: launch.command, args: launch.args };
    if (!acpPreset(launch.provider) && launch.provider !== OXBIT_AGENT_PROVIDER)
      return { registry: launch.registry ?? { id: launch.provider } };
    return undefined;
  }
  async call(method: string, params: Record<string, unknown> = {}) {
    if (!this.connection) throw new Error("Connect an agent first");
    return this.request("acp.call", { id: this.connection.id, method, params });
  }
  /** True when the agent advertises ACP's unstable `session/fork` and the idle conversation has messages. */
  get canForkSession() {
    return !!this.connection?.sessionId && !!this.connection.capabilities?.sessionCapabilities?.fork && this.messages.length > 0 &&
      !this.busy && !this.connecting && !this.sessionStarting && !this.updatingSettings && !this.discovering &&
      !this.requests.length && !this.queue.length && !this.activeSubagentCount;
  }
  /** Forks the agent's session: the new conversation shows the transcript and the agent keeps its whole context. */
  async forkSession() {
    try {
      await this.newSession(true);
    } catch (error) {
      if (error instanceof Error && error.message === "Unsupported ACP client method")
        throw new Error("Update the runtime to fork conversations");
      throw error;
    }
  }
  async newSession(fork = false) {
    if (this.requests.length)
      throw new Error("Resolve pending requests before changing conversations");
    if (this.queue.length)
      throw new Error("Run or remove queued messages before changing conversations");
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
    const draft = this.draft;
    const context = this.context;
    let previous: Conversation | undefined;
    this.changed();
    try {
      await this.saveConversation();
      previous = this.history.entries.find(
        (e) => e.id === this.activeConversation?.id,
      );
      if (generation !== this.connectionGeneration) return;
      this.resetConversation();
      const result = await this.call(fork ? "session/fork" : "session/new");
      if (generation === this.connectionGeneration) {
        if (fork && previous) {
          this.restoreSnapshot(previous);
          this.draft = "";
          this.context = [];
          this.activity.push({ kind: "notice", text: FORKED_NOTICE, values: { title: previous.title } });
        }
        this.connection = result;
        this.activeConversation = {
          id: crypto.randomUUID(),
          sessionId: result.sessionId,
          root: result.root,
          provider: result.provider,
          name: agentName(result.provider, result),
          launch: this.savedLaunch(this.launch),
        };
        this.autoApplyValue = this.autoApply;
        this.status = "Ready";
      }
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      if (previous) this.restoreSnapshot(previous);
      else {
        this.draft = draft;
        this.context = context;
      }
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
  /** Saves the conversation and clears the panel. The agent keeps running on the runtime. */
  async detach() {
    if (this.requests.length)
      throw new Error("Resolve pending requests before changing conversations");
    if (this.queue.length)
      throw new Error("Run or remove queued messages before changing conversations");
    if (this.activeSubagentCount)
      throw new Error(
        "Wait for active subagents or disconnect before changing conversations",
      );
    const connection = this.connection;
    if (!connection || this.connecting || this.sessionStarting || this.updatingSettings || this.discovering)
      return;
    const released = this.options.runtime?.connected
      ? this.request("acp.detach").catch(() => {})
      : undefined;
    if (this.activeConversation)
      this.threadConversations.set(connection.id, this.activeConversation.id);
    this.clearConnection("Disconnected", true);
    await this.saveConversation();
    this.activeConversation = undefined;
    this.resetConversation();
    this.changed();
    await released;
  }
  async listLiveSessions() {
    if (!this.options.runtime?.connected || this.local) return;
    const result = await this.request<{ sessions: ACPLiveSession[] }>("acp.list");
    if (JSON.stringify(result.sessions) === JSON.stringify(this.liveSessions)) return;
    this.liveSessions = result.sessions;
    this.changed();
  }
  async attachLive(id: string) {
    if (this.connection?.id === id) return;
    await this.saveConversation();
    if (this.connection && this.activeConversation)
      this.threadConversations.set(this.connection.id, this.activeConversation.id);
    const generation = ++this.connectionGeneration;
    this.attachBuffer = [];
    try {
      const snapshot = await this.request<ACPSessionSnapshot>("acp.attach", { id, clientCapabilities: { editorTools: true } });
      if (generation !== this.connectionGeneration || this.disposed || !this.options.runtime?.connected) return;
      const draft = this.draft;
      const context = this.context;
      this.resetConversation();
      this.draft = draft;
      this.context = context;
      this.connection = snapshot.connection;
      this.launch = { provider: snapshot.connection.provider, name: snapshot.connection.name };
      rememberAgentName(snapshot.connection.provider, snapshot.connection.name);
      this.activeConversation = {
        id: this.threadConversations.get(id) ?? crypto.randomUUID(), sessionId: snapshot.connection.sessionId ?? "",
        root: snapshot.connection.root, provider: snapshot.connection.provider,
        name: agentName(snapshot.connection.provider, snapshot.connection),
        launch: this.savedLaunch(this.launch),
      };
      const saved = this.history.entries.find((entry) => entry.id === this.activeConversation?.id);
      this.autoApplyValue = saved ? saved.autoApplyEdits === true : this.autoApply;
      this.replayTruncated = snapshot.truncated;
      this.status = snapshot.busy ? "Working…" : "Ready";
      this.replaying = true;
      try {
        for (const event of snapshot.events) this.deliver(event.name, event.params);
      } finally {
        this.replaying = false;
      }
      if (saved && !this.agentTitled && saved.title !== "New conversation") this.title = saved.title;
      this.lastSequence = Math.max(this.lastSequence, snapshot.sequence);
      this.queue = snapshot.queue;
      this.queuePaused = snapshot.queuePaused;
      this.busy = snapshot.busy;
      for (const request of snapshot.requests) void this.clientRequest(request);
      for (const event of this.attachBuffer ?? []) this.deliver(event.name, event.params);
      this.changed();
    } catch (error) {
      for (const event of this.attachBuffer ?? []) this.deliver(event.name, event.params);
      throw error;
    } finally {
      this.attachBuffer = undefined;
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
    if (this.queue.length)
      throw new Error("Run or remove queued messages before changing conversations");
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
      name: copy.name,
      launch: copy.launch,
    };
    this.title = copy.title;
    this.titleRequested = true;
    this.autoApplyValue = copy.autoApplyEdits === true;
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
    if (this.queue.length)
      throw new Error("Run or remove queued messages before changing conversations");
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
    const sameCustom =
      entry.provider !== ACP_CUSTOM_PROVIDER ||
      (this.launch.command === entry.launch?.command &&
        JSON.stringify(this.launch.args ?? []) === JSON.stringify(entry.launch?.args ?? []));
    if (
      this.connection?.provider === entry.provider &&
      this.connection.root === entry.root &&
      sameCustom
    )
      return this.restoreConversation(entry);
    await this.disconnect();
    const saved = entry.launch;
    const launch: ACPLaunch =
      entry.provider === ACP_CUSTOM_PROVIDER
        ? { provider: entry.provider, name: saved?.name ?? entry.name, command: saved?.command, args: saved?.args }
        : acpPreset(entry.provider)
          ? { provider: entry.provider }
          : { provider: entry.provider, registry: saved?.registry ?? { id: entry.provider } };
    await this.connect(resolveLaunch(launch, this.options.kernel.configuration), entry);
  }
  async restoreConversation(entry: Conversation) {
    if (this.requests.length)
      throw new Error("Resolve pending requests before changing conversations");
    if (this.queue.length)
      throw new Error("Run or remove queued messages before changing conversations");
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
      if (method === "session/load") carryCheckpoints(entry.activity, this.activity);
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
  async attachImage(file: File) {
    if (!this.connection) throw new Error("Connect an agent to attach images");
    const count = () => this.context.filter((item) => item.kind === "image").length;
    const accepted = !!this.connection.capabilities?.promptCapabilities?.image;
    const error = imageError(file, count(), accepted);
    if (error) throw new Error(error);
    if (this.context.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    const { mimeType, data } = await encodeImage(file);
    if (count() >= 4 || this.context.length >= 8)
      throw new Error("Attach up to 4 images per message");
    this.context.push(imageContext(file.name, mimeType, data));
    this.changed();
  }
  async attachMention(mention: Mention) {
    if (mention.kind === "changes") return this.attachChanges();
    if (mention.kind === "symbol") return this.attachSymbol(mention);
    if (mention.kind === "thread") return this.attachThread(mention.id);
    if (mention.kind === "branch") return this.attachBranchDiff();
    if (mention.kind === "commit") return this.attachCommit(mention);
    if (mention.kind === "folder") return this.attachFolder(mention.path);
    if (mention.kind !== "file")
      return mention.kind === "selection" ? this.attach(true) : this.attachDiagnostics();
    if (this.context.some((item) => item.kind === "file" && item.path === mention.path)) return;
    await this.attachPath(mention.path);
  }
  async attachSymbol({ name, path, line, endLine }: SymbolMention) {
    const document = await this.documents.open(path);
    if (this.context.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    const text = document.text.toString().split("\n").slice(line - 1, endLine).join("\n");
    if (text.length > 200000)
      throw new Error("Select a smaller portion of this file (maximum 200,000 characters)");
    this.context.push({ path, text, line, endLine, version: document.version, kind: "selection", label: `${name} ${path}:${line}-${endLine}` });
    this.changed();
  }
  /** Saved conversations for `@` other than the open one, from the connected root when there is one. */
  mentionThreads(query: string) {
    return searchThreads(this.history.entries, query, { exclude: this.activeConversation?.id, root: this.connection?.root });
  }
  attachThread(id: string) {
    const entry = this.history.entries.find((item) => item.id === id);
    if (!entry) throw new Error("This conversation is no longer in history");
    const text = threadTranscript(entry);
    if (!text) throw new Error("This conversation has no messages");
    if (this.context.some((item) => item.kind === "thread" && item.text === text)) return;
    if (this.context.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    this.context.push({ path: ".", text, kind: "thread", label: `Thread: ${entry.title}` });
    this.changed();
  }
  async attachChanges() {
    const others = this.context.filter((item) => item.kind !== "changes");
    if (others.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    const text = await uncommittedChanges((method, params) => this.request(method, params ?? {}));
    this.context = [...others, { path: ".", text, kind: "changes", label: "Uncommitted changes" }];
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
  /** False once `git.branchDiff` is missing: an older runtime, or the in-app runtime of a device folder. */
  branchDiffAvailable = true;
  private branchDiffProbe?: Promise<void>;
  /** Asks once whether the runtime serves `git.branchDiff`, with a request that diffs no files. */
  probeBranchDiff() {
    if (this.branchDiffProbe || !this.options.runtime?.connected) return;
    this.branchDiffProbe = this.request("git.branchDiff", { limit: 0 }).then(() => {}, (error) => void this.branchDiffMissing(error));
  }
  private branchDiffMissing(error: unknown) {
    const missing = (error as { code?: unknown } | null)?.code === "METHOD_NOT_FOUND" ||
      (error instanceof Error && /needs a runtime workspace$/.test(error.message));
    if (missing && this.branchDiffAvailable) {
      this.branchDiffAvailable = false;
      this.changed();
    }
    return missing;
  }
  async attachBranchDiff() {
    const others = this.context.filter((item) => item.kind !== "branch");
    if (others.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    const diff = await branchChanges((method, params) => this.request(method, params ?? {})).catch((error) => {
      throw this.branchDiffMissing(error) ? new Error("Branch diff needs a runtime workspace") : error;
    });
    this.context = [...others, { path: ".", kind: "branch", ...diff }];
    this.changed();
  }
  /** Commits for `@` from the latest 100 whose subject, short hash or author matches. */
  async mentionCommits(query: string) {
    if (!query.trim()) return [];
    return searchCommits((await this.request<GitLog>("git.log", { limit: 100 })).commits, query);
  }
  async attachCommit({ id, subject }: CommitMention) {
    const label = `Commit ${id.slice(0, 7)}: ${subject.slice(0, 100)}`;
    if (this.context.some((item) => item.kind === "commit" && item.label === label)) return;
    if (this.context.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    const text = await commitChanges((method, params) => this.request(method, params ?? {}), id);
    this.context.push({ path: ".", text, kind: "commit", label });
    this.changed();
  }
  async attachFolder(path: string) {
    if (this.context.some((item) => item.kind === "folder" && item.path === path)) return;
    if (this.context.length >= 8)
      throw new Error("Attach up to eight files or selections per message");
    const text = await folderText(this.options.filesystem, path);
    this.context.push({ path, text, kind: "folder", label: `Folder: ${path}` });
    this.changed();
  }
  async send() {
    if (
      this.checkpointing ||
      this.connecting ||
      this.updatingSettings ||
      this.discovering ||
      this.archived ||
      !this.draft.trim()
    )
      return;
    if (this.local && this.draft.trim() === `/${UNDO_COMMAND.name}`) {
      await this.undoLastTurn();
      this.draft = "";
      this.changed();
      return;
    }
    if (!this.connection) {
      const draft = this.draft;
      const context = this.context;
      const autoApply = this.autoApplyValue;
      try {
        await this.connectSelected();
      } finally {
        // Starting a conversation resets the composer; the pending draft belongs to it.
        this.draft = draft;
        this.context = context;
        this.autoApplyValue = autoApply ?? this.autoApplyValue;
        this.changed();
      }
      const connection = this.connection as ACPConnection | undefined;
      if (!connection) return;
      if (!connection.sessionId)
        throw new Error("Sign in to the agent, then send your message");
    }
    const prompt = this.draft.trim();
    const context = this.context.map((c) => ({ ...c }));
    const draft = this.draft;
    const contextSnapshot = JSON.stringify(this.context);
    if (JSON.stringify({ prompt, context: withoutImageData(context) }).length > 1000000)
      throw new Error("The message and attachments are too large");
    if (!this.connection?.sessionId)
      throw new Error("Start a conversation first");
    if (this.busy) {
      const queueRevision = this.queueRevision;
      const generation = this.connectionGeneration;
      const result = await this.request<{ queue: ACPQueuedPrompt[]; paused: boolean }>(
        "acp.enqueue", { id: this.connection.id, text: prompt, context, messageId: crypto.randomUUID() },
      );
      if (generation !== this.connectionGeneration) return;
      if (this.queueRevision === queueRevision) {
        this.queue = result.queue;
        this.queuePaused = result.paused;
      }
      if (this.draft === draft && JSON.stringify(this.context) === contextSnapshot) {
        this.draft = "";
        this.context = [];
      }
      this.changed();
      return;
    }
    const message: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: prompt,
      context: withoutImageData(context),
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
      this.checkpointing = true;
      try {
        message.checkpoint = await this.checkpoints.create();
      } finally {
        this.checkpointing = false;
      }
      if (generation !== this.connectionGeneration) return;
      const result = await this.call("session/prompt", {
        text: prompt,
        messageId: message.id,
        ...(context.length ? { context } : {}),
      });
      if (generation !== this.connectionGeneration) return;
      if (!this.activeTurnId || this.activeTurnId === message.id)
        this.status = result?.stopReason === "cancelled" ? "Stopped" : "Ready";
      if (result?.stopReason && result.stopReason !== "end_turn")
        this.activity.push({
          kind: "notice",
          text: `Turn ended: ${result.stopReason}`,
        });
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      if (!this.activeTurnId || this.activeTurnId === message.id) this.status = "Turn failed";
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
        if (!this.activeTurnId || this.activeTurnId === message.id) {
          this.busy = this.cancelling = false;
          this.rootRequestGeneration++;
          this.requests = this.requests.filter((r) => this.isChildRequest(r));
        }
        this.changed();
        await this.saveConversation();
      }
    }
  }
  async removeQueued(promptId: string) {
    if (!this.connection) return;
    await this.request("acp.dequeue", { id: this.connection.id, promptId });
    this.queue = this.queue.filter(prompt => prompt.id !== promptId);
    this.changed();
  }
  async editQueued(promptId: string) {
    const prompt = this.queue.find(item => item.id === promptId);
    if (!prompt) return;
    await this.removeQueued(promptId);
    this.draft = prompt.text;
    this.context = prompt.context ?? [];
    this.changed();
  }
  /** Stops the running turn and sends a queued message next. */
  async sendQueuedNow(promptId: string) {
    const connection = this.connection;
    const prompt = this.queue.find(item => item.id === promptId);
    if (!connection || !prompt || !this.busy || this.cancelling) return;
    const generation = this.connectionGeneration;
    const turnId = this.activeTurnId;
    // Dequeue first: a fast queue would otherwise start the original before it is removed.
    await this.removeQueued(promptId);
    if (generation !== this.connectionGeneration) return;
    const message = { id: connection.id, text: prompt.text, context: prompt.context, messageId: prompt.id };
    this.cancelling = true;
    this.status = "Stopping…";
    this.changed();
    try {
      await this.request("acp.interrupt", message);
    } catch (error) {
      if (generation === this.connectionGeneration && this.activeTurnId === turnId && this.cancelling) {
        this.cancelling = false;
        this.status = this.busy ? "Working…" : "Ready";
        this.changed();
      }
      await this.request("acp.enqueue", message).catch(() => undefined);
      throw error;
    }
  }
  private queueMoveUnsupported?: string;
  /** False for a connection whose runtime answered acp.moveQueued with METHOD_NOT_FOUND. */
  get canMoveQueued() {
    return !!this.connection && this.queueMoveUnsupported !== this.connection.id;
  }
  async moveQueued(promptId: string, index: number) {
    const connection = this.connection;
    if (!connection || !this.canMoveQueued) return;
    const generation = this.connectionGeneration;
    const queueRevision = this.queueRevision;
    let result: { queue: ACPQueuedPrompt[]; paused: boolean };
    try {
      result = await this.request("acp.moveQueued", { id: connection.id, promptId, index });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "METHOD_NOT_FOUND") throw error;
      this.queueMoveUnsupported = connection.id;
      throw new Error("Update the runtime to reorder queued messages");
    }
    if (generation !== this.connectionGeneration) return;
    if (this.queueRevision === queueRevision) {
      this.queue = result.queue;
      this.queuePaused = result.paused;
    }
    this.changed();
  }
  async resumeQueue() {
    if (!this.connection) return;
    await this.request("acp.resumeQueue", { id: this.connection.id });
    this.queuePaused = false;
    this.changed();
  }
  async interruptAndSend() {
    if (!this.connection || !this.busy || this.cancelling || !this.draft.trim()) return;
    const text = this.draft.trim();
    const context = this.context.map(item => ({ ...item }));
    const draft = this.draft;
    const contextSnapshot = JSON.stringify(this.context);
    const generation = this.connectionGeneration;
    const queueRevision = this.queueRevision;
    const turnId = this.activeTurnId;
    this.cancelling = true;
    this.status = "Stopping…";
    this.changed();
    try {
      const result = await this.request<{ queue: ACPQueuedPrompt[]; paused: boolean }>(
        "acp.interrupt", { id: this.connection.id, text, context, messageId: crypto.randomUUID() },
      );
      if (generation !== this.connectionGeneration) return;
      if (this.queueRevision === queueRevision) {
        this.queue = result.queue;
        this.queuePaused = result.paused;
      }
      if (this.draft === draft && JSON.stringify(this.context) === contextSnapshot) {
        this.draft = "";
        this.context = [];
      }
      this.changed();
    } catch (error) {
      if (generation === this.connectionGeneration && this.activeTurnId === turnId && this.cancelling) {
        this.cancelling = false;
        this.status = this.busy ? "Working…" : "Ready";
        this.changed();
      }
      throw error;
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
      // A plan card posted mid-message stays below the text that continues it.
      const previous = this.activity.findLast((entry) => entry.kind !== "plan");
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
    ) {
      this.title = update.title.slice(0, 200);
      this.agentTitled = true;
    }
    else if (update.sessionUpdate === "usage_update") {
      const usage = update.usage ?? update;
      if (Number.isFinite(usage.used) && Number.isFinite(usage.size) && usage.size > 0)
        this.usage = { used: Math.max(0, usage.used), size: usage.size,
          ...(usage.cost && Number.isFinite(usage.cost.amount) && typeof usage.cost.currency === "string"
            ? { cost: usage.cost } : {}) };
    }
    else if (update.sessionUpdate === "plan") this.updatePlan(update.entries ?? []);
    else if (update.sessionUpdate === "available_commands_update")
      this.commands = [...(update.availableCommands ?? []), ...(this.local ? [UNDO_COMMAND] : [])];
    else if (
      update.sessionUpdate === "current_mode_update" &&
      this.connection?.modes
    )
      this.connection.modes.currentModeId = update.currentModeId;
    else if (update.sessionUpdate === "config_option_update" && this.connection)
      this.connection.configOptions = update.configOptions;
    else if (update.sessionUpdate === "cursor/update_todos")
      this.updatePlan(update.todos ?? []);
    else if (update.sessionUpdate?.startsWith("cursor/"))
      this.logs = (this.logs + "\n" + JSON.stringify(update)).slice(-65536);
    while (this.activity.length > 200) this.activity.shift();
  }
  /** One plan card per turn, placed at the turn's first plan update. */
  private updatePlan(entries: PlanEntry[]) {
    const index = this.activity.findLastIndex((entry) => entry.kind === "plan");
    const sameTurn = index >= 0 && !this.activity.slice(index + 1).some(
      (entry) => entry.kind === "message" && entry.message.role === "user");
    if (sameTurn) this.activity[index] = { kind: "plan", entries };
    else if (entries.length) this.activity.push({ kind: "plan", entries });
  }
  private async clientRequest(request: AgentRequest) {
    if (this.pendingClientRequests.has(request.requestId) || this.requests.some(item => item.requestId === request.requestId)) return;
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
      if (["oxbit/workspace", "oxbit/diagnostics", "oxbit/open_file"].includes(request.method)) {
        const path = request.params.path;
        if (path !== undefined && (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || path.includes("\0")))
          throw new Error("Choose a file inside the workspace");
        const workbench = this.options.workbench as typeof this.options.workbench & { state?: { groups?: { tabs: { path?: string }[] }[] } };
        const openFiles = [...new Set((workbench.state?.groups ?? []).flatMap(group => group.tabs.map(tab => tab.path).filter((item): item is string => !!item)))].slice(0, 100);
        const activeFile = this.options.workbench.activePath();
        const diagnostics = (target?: string) => {
          const service = this.options.kernel.services.get<any>("language");
          const paths = target ? [target] : openFiles;
          return paths.flatMap(file => (service?.diagnostics?.get(file) ?? []).slice(0, 100).map((item: any) => ({
            path: file, line: (item.range?.start?.line ?? 0) + 1,
            character: (item.range?.start?.character ?? 0) + 1,
            message: String(item.message ?? "").slice(0, 4000),
            source: item.source, severity: item.severity,
          }))).slice(0, 200);
        };
        if (request.method === "oxbit/diagnostics") {
          if (valid()) await this.respond(request, { diagnostics: diagnostics(path) });
          return;
        }
        if (request.method === "oxbit/open_file") {
          if (typeof path !== "string") throw new Error("Choose a file inside the workspace");
          const line = request.params.line;
          if (line !== undefined && (!Number.isInteger(line) || line < 1)) throw new Error("Line must be a positive integer");
          await this.openLocation(path, line === undefined ? undefined : line - 1);
          if (valid()) await this.respond(request, { path });
          return;
        }
        const editor = this.options.workbench.activeEditor();
        const range = editor?.state?.selection?.main;
        const document = activeFile ? this.documents.get(activeFile) : undefined;
        const selection = activeFile && document && range && !range.empty
          ? { path: activeFile, text: document.text.toString().slice(range.from, Math.min(range.to, range.from + 200000)),
              line: document.text.toString().slice(0, range.from).split("\n").length }
          : undefined;
        if (valid()) await this.respond(request, { activeFile, openFiles, selection, diagnostics: diagnostics(activeFile) });
        return;
      }
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
          if (!missingFile(error)) throw error;
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
        if (request.method === "fs/write_text_file" && (this.autoApply || modeApplies(this.connection?.provider, request.params))) {
          await this.writeFile(request, false).catch((error) => {
            this.error = String(error);
            this.changed();
          });
          return;
        }
        this.requests.push(request);
        this.attention.requestArrived(this.title);
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
  /** Resolves true when the write was applied and false when the file changed during review. */
  async applyFile(request: AgentRequest) {
    if (!this.requests.includes(request) || this.connection?.id !== request.id)
      throw new Error("File review has expired");
    if (this.fileActions.has(request.requestId)) return false;
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
      return false;
    }
    return this.writeFile(request, true);
  }
  /** Saves the agent's write, records it for Undo and answers the agent. `open` shows the file in the editor. */
  private async writeFile(request: AgentRequest, open: boolean) {
    const document = this.documents.get(request.params.path);
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
        turn: this.activeTurnId,
      });
      while (this.changes.length > 30) this.changes.shift();
      this.activity.push({
        kind: "notice",
        text: `Applied change: ${request.params.path}`,
      });
      await this.respond(request, null);
      if (open && !this.panelCoversEditor())
        await this.options.workbench.openFile(request.params.path, {
          preview: false,
        });
      await this.options.workbench.refreshFiles();
      return true;
    } catch (error) {
      await this.respond(request, undefined, String(error)).catch(() => {});
      throw error;
    } finally {
      this.fileActions.delete(request.requestId);
    }
  }
  /** True while Apply all, Reject all or Undo all runs; review buttons stay disabled. */
  reviewingAll = false;
  get pendingWrites() {
    return this.requests.filter((request) => request.method === "fs/write_text_file");
  }
  get undoableChanges() {
    return this.changes.filter((change) => !change.undone && !change.created);
  }
  /** Applies pending writes in order through Apply change and stops at the first that fails. */
  async applyAllFiles() {
    await this.answerWrites(async (request) => {
      if (!(await this.applyFile(request)))
        throw new Error(`File changed during review: ${request.params.path}`);
    });
  }
  async rejectAllFiles() {
    await this.answerWrites((request) => this.respond(request, undefined, FILE_REJECTED));
  }
  /** Undoes applied edits newest first and stops at the first that cannot be undone. */
  async undoAllChanges() {
    const changes = this.undoableChanges.reverse();
    await this.reviewAll(changes.map((change) => change.id), async () => {
      for (const change of changes) await this.undoChange(change.id);
    });
  }
  private async answerWrites(answer: (request: AgentRequest) => Promise<unknown>) {
    const writes = this.pendingWrites;
    await this.reviewAll(writes.map((request) => request.requestId), async () => {
      for (const request of writes) if (this.requests.includes(request)) await answer(request);
    });
  }
  private async reviewAll(keys: string[], run: () => Promise<void>) {
    if (this.reviewingAll || !keys.length) return;
    if (keys.some((key) => this.fileActions.has(key)))
      throw new Error("Wait for the current file review to finish");
    this.reviewingAll = true;
    this.changed();
    try {
      await run();
    } finally {
      this.reviewingAll = false;
      this.changed();
    }
  }
  /** In-app `/undo`: undoes the applied edits of the latest turn that has any, newest first. */
  async undoLastTurn() {
    const latest = this.undoableChanges.at(-1);
    if (!latest) {
      this.activity.push({ kind: "notice", text: "No agent edits to undo." });
      return this.changed();
    }
    const changes = this.undoableChanges.filter((change) => change.turn === latest.turn).reverse();
    await this.reviewAll(changes.map((change) => change.id), async () => {
      for (const change of changes) await this.undoChange(change.id);
    });
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
  /** Restores the files to before `message`; `note` adds a notice to the conversation. */
  async restoreCheckpoint(message: Message, note = true) {
    if (!message.checkpoint || !this.connection) return false;
    if (this.busy || this.connecting || this.requests.length || this.activeSubagentCount)
      throw new Error("Wait for the agent to finish before restoring a checkpoint");
    const paths = await this.checkpoints.restore(message.checkpoint, (path) => !!this.documents.get(path)?.dirty);
    if (!paths) return false;
    if (note) this.activity.push(restoredNotice(message));
    this.changed();
    await this.options.workbench.refreshFiles();
    return true;
  }
  /** Starts a new conversation with the same agent: the messages before `message` attached as a thread, its text in the draft. */
  async forkFrom(message: Message, restore = false) {
    const index = this.activity.findIndex((item) => item.kind === "message" && item.message === message);
    const conversation = this.activeConversation;
    if (index < 0 || !conversation || !this.connection) return;
    if (this.busy || this.connecting || this.sessionStarting || this.updatingSettings || this.discovering ||
      this.requests.length || this.queue.length || this.activeSubagentCount)
      throw new Error("Wait for the agent to finish before forking");
    const thread = forkContext({ ...conversation, title: this.title, activity: this.activity }, index);
    if (restore && !(await this.restoreCheckpoint(message, false))) return;
    await this.newSession();
    if (this.activeConversation?.id === conversation.id || !this.connection?.sessionId) return;
    this.draft = message.text;
    this.context = thread ? [thread] : [];
    if (restore) this.activity.push(restoredNotice(message));
    this.changed();
  }
  /** After the first turn, asks the Oxbit Agent model for a title when the agent sent none. */
  private async nameConversation() {
    const config = this.options.kernel.configuration;
    const models = this.options.kernel.services.optional<AgentModels>(AGENT_MODELS_SERVICE);
    const model = config?.get<string>(OXBIT_AGENT_SETTINGS.model)?.trim();
    const endpoint = oxbitEndpoint(config);
    const users = this.messages.filter((message) => message.role === "user");
    if (this.titleRequested || this.agentTitled || users.length !== 1 || !this.connection ||
      config?.get<boolean>("agentACP.generateTitles") === false || !models || !model || (endpoint.api === "openai-compatible" && !endpoint.baseUrl))
      return;
    this.titleRequested = true;
    const conversation = this.activeConversation?.id;
    const generation = this.connectionGeneration;
    const reply = this.messages.slice(this.messages.indexOf(users[0]) + 1)
      .filter((message) => message.role === "agent").map((message) => message.text).join("\n\n");
    try {
      const title = await generateTitle(models, endpoint, model, users[0].text, reply);
      if (!title || this.agentTitled || this.disposed || generation !== this.connectionGeneration || conversation !== this.activeConversation?.id) return;
      this.title = title;
      this.changed();
    } catch {
      // The first message stays the title.
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
  /** Below the workbench's 1100px breakpoint the panel overlays the editor, and opening a file closes it. */
  private panelCoversEditor() {
    return (globalThis.innerWidth || 1440) < 1100 && this.options.workbench.panelVisible?.(AGENT_VIEW) === true;
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
  private latestToolTitle() {
    let title: string | undefined;
    for (const call of this.tools.values()) if (typeof call.title === "string") title = call.title;
    return title;
  }
  dispose() {
    this.attention.dispose();
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
/** Display data for a provider ID. Unknown IDs keep their own ID as the label. */
export const providerFor = (id: string) => ({ id, name: agentName(id) });
