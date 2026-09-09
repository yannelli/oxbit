import type {
  ACPProviderId,
  ACPSubagent,
  ACPSubagentPhase,
  ACPSubagentState,
} from "@oxbit/sdk";

type Data = Record<string, any>;
type Observation = {
  providerId?: string;
  toolId: string;
  parent?: string;
  name?: string;
  task?: string;
  model?: string;
  state?: ACPSubagentState;
  result?: string;
  durationMs?: number;
  evidence: "provider" | "tool";
  spawn?: boolean;
  reopen?: boolean;
};
const terminal = (state: ACPSubagentState) =>
  !["pending", "running", "unknown"].includes(state);
const object = (value: any): Data =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const str = (value: any, max = 4096): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;
const identity = (value: any): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes("\0");
const preview = (value: any, max = 8192) =>
  value === undefined
    ? undefined
    : (typeof value === "string" ? value : JSON.stringify(value)).slice(0, max);
const statusNames: Record<string, ACPSubagentState> = {
  pendingInit: "pending",
  running: "running",
  completed: "completed",
  errored: "failed",
  failed: "failed",
  interrupted: "cancelled",
  cancelled: "cancelled",
  rejected: "failed",
  shutdown: "disconnected",
  notFound: "disconnected",
  disconnected: "disconnected",
};
function state(value: any): ACPSubagentState | undefined {
  return typeof value === "string" && Object.hasOwn(statusNames, value)
    ? statusNames[value]
    : undefined;
}
const toolKey = (sessionId: string, toolId: string) =>
  JSON.stringify([sessionId, toolId]);
function toolOutput(update: Data) {
  if (update.rawOutput !== undefined) return update.rawOutput;
  if (!Array.isArray(update.content)) return update.content;
  return update.content
    .map(
      (item: any) =>
        item?.content?.text ??
        item?.content?.resource?.text ??
        (item?.type === "diff"
          ? `${item.path}\n${item.newText ?? ""}`
          : JSON.stringify(item)),
    )
    .join("\n");
}
/** Provider-specific evidence only. A tool's completion is not a child's completion. */
export function normalizeDelegation(
  provider: ACPProviderId,
  update: Data,
): Observation[] {
  const raw = object(update.rawInput),
    meta = object(update._meta?.codex);
  const toolId = update.toolCallId;
  if (!identity(toolId)) return [];
  if (provider === "codex") {
    const collab = object(meta.collaboration),
      sub = object(meta.subagent);
    if (identity(sub.threadId))
      return [
        {
          providerId: sub.threadId,
          toolId,
          name: str(str(sub.path)?.split("/").filter(Boolean).at(-1), 200),
          state: state(sub.activity === "started" ? "running" : sub.activity),
          evidence: "provider",
          spawn: sub.activity === "started",
        },
      ];
    if (!identity(collab.tool)) return [];
    const receivers = Array.isArray(collab.receiverThreadIds)
      ? collab.receiverThreadIds.filter(identity)
      : [];
    const states = object(raw.agentsStates);
    const ids = [
      ...new Set([...receivers, ...Object.keys(states).filter(identity)]),
    ];
    if (!ids.length && collab.tool === "spawnAgent")
      return [
        {
          toolId,
          task: str(raw.prompt),
          state: update.status === "failed" ? "failed" : "unknown",
          evidence: "tool",
          spawn: true,
        },
      ];
    return ids.map((providerId) => ({
      providerId,
      toolId,
      parent: str(collab.senderThreadId, 512),
      task: str(raw.prompt),
      model: str(raw.model, 200),
      state:
        state(states[providerId]?.status) ??
        (collab.tool === "spawnAgent" && update.status === "failed"
          ? "failed"
          : undefined),
      result: str(states[providerId]?.message, 16384),
      evidence: "provider",
      spawn: collab.tool === "spawnAgent",
      reopen:
        ["resumeAgent", "sendInput", "followupTask"].includes(collab.tool) &&
        ["running", "pendingInit"].includes(states[providerId]?.status),
    }));
  }
  if (provider === "cursor" && update.taskMeta) {
    const task = object(update.taskMeta),
      output = object(update.rawOutput);
    const outcome = object(task.outcome ?? output.outcome);
    const outcomeName =
      typeof (task.outcome ?? output.outcome) === "string"
        ? (task.outcome ?? output.outcome)
        : outcome.outcome;
    return [
      {
        toolId,
        providerId: identity(task.agentId ?? outcome.agentId)
          ? (task.agentId ?? outcome.agentId)
          : undefined,
        name: str(task.description, 200),
        task: str(task.prompt),
        model: str(task.model, 200),
        durationMs:
          Number.isFinite(task.durationMs ?? outcome.durationMs) &&
          (task.durationMs ?? outcome.durationMs) >= 0
            ? (task.durationMs ?? outcome.durationMs)
            : undefined,
        state: state(outcomeName),
        result: preview(task.result ?? outcome.result ?? output.result),
        evidence: state(outcomeName) ? "provider" : "tool",
        spawn: true,
      },
    ];
  }
  if (
    provider === "amp" &&
    update.kind === "think" &&
    /^Task(?:: |$)/.test(update.title ?? "") &&
    (typeof raw.prompt === "string" ||
      typeof raw.description === "string" ||
      typeof raw.subagent_type === "string")
  ) {
    return [
      {
        toolId,
        name: str(raw.description ?? raw.subagent_type, 200),
        task: str(raw.prompt),
        model: str(raw.model, 200),
        state: update.status === "failed" ? "failed" : "unknown",
        evidence: "tool",
        spawn: true,
      },
    ];
  }
  return [];
}

/** Authorization is kept separately from bounded display activity and tool caches. */
export class SubagentRegistry {
  readonly records = new Map<string, ACPSubagent>();
  private sessions = new Map<
    string,
    { parent: string; state: ACPSubagentState; historical: boolean }
  >();
  private fallbackStates = new Map<
    string,
    { state: ACPSubagentState; historical: boolean; reopenToolId?: string }
  >();
  private tools = new Map<string, Data>();
  private aliases = new Map<string, string>();
  private waits = new Map<string, Set<string>>();
  private early = new Map<string, Data[]>();
  private earlyStates = new Map<
    string,
    { parent: string; state: ACPSubagentState }
  >();
  private serial = 0;
  truncated = false;
  replaying = false;
  constructor(
    readonly provider: ACPProviderId,
    readonly root: string,
    private emit: (value: {
      subagent: ACPSubagent;
      activeCount: number;
      removedIds: string[];
      truncated: boolean;
    }) => void,
  ) {}
  accepts(sessionId: any) {
    return (
      sessionId === this.root ||
      (identity(sessionId) && this.sessions.has(sessionId))
    );
  }
  acceptsRequest(sessionId: any) {
    return (
      sessionId === this.root ||
      (this.sessions.has(sessionId) &&
        !terminal(this.sessions.get(sessionId)!.state))
    );
  }
  get activeCount() {
    const native = [...this.sessions.values()].filter(
      (s) => !s.historical && ["pending", "running"].includes(s.state),
    ).length;
    return (
      native +
      [...this.fallbackStates.values()].filter(
        (r) => !r.historical && ["pending", "running"].includes(r.state),
      ).length
    );
  }
  idForSession(sessionId: string) {
    return this.sessions.has(sessionId)
      ? `${this.provider}:${sessionId}`
      : undefined;
  }
  idForTool(sessionId: string, toolId: string) {
    return this.aliases.get(`tool:${toolKey(sessionId, toolId)}`);
  }
  private create(id: string, parentId?: string): ACPSubagent {
    const now = new Date().toISOString();
    return {
      id,
      parentId,
      rootSessionId: this.root,
      provider: this.provider,
      name: "Subagent",
      task: "",
      toolCallIds: [],
      state: "unknown",
      phase: "unknown",
      evidence: "tool",
      visibility: "limited",
      order: ++this.serial,
      observedAt: now,
      updatedAt: now,
      activity: [],
      historical: this.replaying,
    };
  }
  private publish(
    record: ACPSubagent,
    removedIds: string[] = [],
    live = false,
  ) {
    record.updatedAt = new Date().toISOString();
    record.historical = live ? false : this.replaying;
    if (record.activity.length > 32) {
      record.activity.splice(0, record.activity.length - 32);
      record.truncated = true;
    }
    this.records.set(record.id, record);
    // Bound display records, never the separately registered session authority.
    while (this.records.size > 256) {
      const victim =
        [...this.records.values()].find(
          (r) => r.id !== record.id && terminal(r.state),
        ) ?? [...this.records.values()].find((r) => r.id !== record.id)!;
      this.records.delete(victim.id);
      removedIds.push(victim.id);
      this.truncated = true;
    }
    // Per-child previews plus a shared detail budget keep snapshots inexpensive.
    let bytes = [...this.records.values()].reduce(
      (n, r) => n + JSON.stringify(r.activity).length,
      0,
    );
    const pruned: ACPSubagent[] = [];
    for (const r of this.records.values()) {
      if (bytes <= 512000) break;
      if (!r.activity.length) continue;
      bytes -= JSON.stringify(r.activity).length;
      r.activity = [];
      r.truncated = true;
      pruned.push(r);
    }
    for (const r of pruned)
      if (r !== record)
        this.emit({
          subagent: structuredClone(r),
          activeCount: this.activeCount,
          removedIds: [],
          truncated: this.truncated,
        });
    this.emit({
      subagent: structuredClone(record),
      activeCount: this.activeCount,
      removedIds,
      truncated: this.truncated,
    });
  }
  private transition(record: ACPSubagent, next?: ACPSubagentState) {
    if (!next || terminal(record.state)) return;
    record.state = next;
    if (terminal(next)) {
      record.endedAt = new Date().toISOString();
      record.phase = "unknown";
    }
  }
  observe(sessionId: string, update: Data): boolean {
    if (!this.accepts(sessionId)) {
      // Never authorize an unknown session. Only replay this bounded data if its parent later registers it.
      if (
        this.provider === "codex" &&
        identity(sessionId) &&
        this.early.size < 32 &&
        JSON.stringify(update).length <= 16384
      ) {
        const buffered = this.early.get(sessionId) ?? [];
        if (buffered.length < 8) buffered.push(structuredClone(update));
        this.early.set(sessionId, buffered);
      }
      return false;
    }
    if (
      this.provider === "codex" &&
      update.sessionUpdate === "subagent_spawned"
    ) {
      const child = update.subagentSessionId;
      if (!identity(child) || child === this.root || child === sessionId)
        return false;
      const previous = this.sessions.get(child);
      if (previous && previous.parent !== sessionId) return false;
      if (!previous && this.sessions.size >= 1024)
        throw new Error("Too many registered subagent sessions");
      // A new node cannot be an ancestor: an existing node cannot be reparented.
      this.sessions.set(
        child,
        previous ?? {
          parent: sessionId,
          state: "running",
          historical: this.replaying,
        },
      );
      const id = `${this.provider}:${child}`;
      this.fallbackStates.delete(id);
      const record =
        this.records.get(id) ?? this.create(id, this.idForSession(sessionId));
      if (record.evidence !== "native") {
        record.state = "unknown";
        record.phase = "unknown";
        record.endedAt = undefined;
      }
      Object.assign(record, {
        parentId: this.idForSession(sessionId),
        sessionId: child,
        providerId: child,
        name: str(update.name, 200) || record.name,
        task: str(update.task) ?? record.task,
        evidence: "native",
        visibility: "full",
      });
      this.transition(record, previous?.state ?? "running");
      const earlyState = this.earlyStates.get(child);
      if (earlyState?.parent === sessionId) {
        this.transition(record, earlyState.state);
        this.sessions.get(child)!.state = record.state;
        this.earlyStates.delete(child);
      }
      this.publish(record);
      for (const event of this.early.get(child) ?? [])
        this.observe(child, event);
      this.early.delete(child);
      return true;
    }
    if (
      this.provider === "codex" &&
      update.sessionUpdate === "subagent_state_update"
    ) {
      const child = update.subagentSessionId,
        next = state(update.state),
        known = this.sessions.get(child);
      if (!identity(child) || !next || !terminal(next)) return false;
      if (!known) {
        if (this.earlyStates.size < 64)
          this.earlyStates.set(child, { parent: sessionId, state: next });
        return false;
      }
      if (known.parent !== sessionId) return false;
      if (!terminal(known.state)) known.state = next;
      known.historical = this.replaying;
      const record =
        this.records.get(`${this.provider}:${child}`) ??
        this.create(`${this.provider}:${child}`, this.idForSession(sessionId));
      Object.assign(record, {
        sessionId: child,
        providerId: child,
        evidence: "native",
        visibility: "full",
      });
      this.transition(record, known.state);
      this.publish(record);
      return true;
    }
    const childId = this.idForSession(sessionId);
    if (childId) this.activity(sessionId, update);
    if (
      ["tool_call", "tool_call_update", "cursor/task"].includes(
        update.sessionUpdate,
      ) &&
      identity(update.toolCallId)
    ) {
      const key = toolKey(sessionId, update.toolCallId);
      const old = this.tools.get(key) ?? {};
      const tool: Data =
        update.sessionUpdate === "cursor/task"
          ? {
              ...old,
              toolCallId: update.toolCallId,
              taskMeta: { ...old.taskMeta, ...update },
            }
          : { ...old, ...update };
      // Don't let a late pending update rewind an already completed tool.
      if (["completed", "failed"].includes(old.status))
        tool.status = old.status;
      if (JSON.stringify(tool).length <= 65536) this.tools.set(key, tool);
      while (this.tools.size > 256)
        this.tools.delete(this.tools.keys().next().value!);
      for (const item of normalizeDelegation(this.provider, tool)) {
        if (item.providerId === this.root || item.providerId === sessionId)
          continue;
        let id = item.providerId
          ? `${this.provider}:${item.providerId}`
          : `tool:${key}`;
        const alias =
          item.providerId && this.aliases.get(`provider:${item.providerId}`);
        if (alias) id = alias;
        const previous = this.records.get(id);
        const previousState = this.fallbackStates.get(id);
        if (
          item.reopen &&
          !this.sessions.has(item.providerId ?? "") &&
          terminal(previousState?.state ?? previous?.state ?? "unknown") &&
          previousState?.reopenToolId !== item.toolId
        )
          id = `generation:${JSON.stringify([this.provider, item.providerId, item.toolId])}`;
        const placeholderId = `tool:${key}`,
          placeholder = this.records.get(placeholderId);
        const parentId =
          item.spawn && item.parent
            ? (this.aliases.get(`provider:${item.parent}`) ??
              this.idForSession(item.parent))
            : childId;
        const record =
          this.records.get(id) ??
          (placeholder
            ? { ...placeholder, id, parentId: parentId ?? placeholder.parentId }
            : this.create(id, parentId));
        const native = item.providerId && this.sessions.get(item.providerId);
        if (native) {
          Object.assign(record, {
            sessionId: item.providerId,
            parentId: this.idForSession(native.parent),
            evidence: "native",
            visibility: "full",
          });
          this.transition(record, native.state);
        } else {
          const remembered = this.fallbackStates.get(id);
          if (remembered) this.transition(record, remembered.state);
        }
        const removed: string[] = [];
        if (placeholder && placeholderId !== id) {
          this.records.delete(placeholderId);
          this.fallbackStates.delete(placeholderId);
          removed.push(placeholderId);
        }
        if (item.providerId)
          this.aliases.set(`provider:${item.providerId}`, id);
        this.aliases.set(`tool:${toolKey(sessionId, item.toolId)}`, id);
        while (this.aliases.size > 2048)
          this.aliases.delete(this.aliases.keys().next().value!);
        if (!record.toolCallIds.includes(item.toolId))
          record.toolCallIds = [...record.toolCallIds, item.toolId].slice(-32);
        record.providerId = item.providerId ?? record.providerId;
        record.name = item.name || record.name;
        if (item.spawn) record.task = item.task ?? record.task;
        record.model = item.model ?? record.model;
        record.durationMs = item.durationMs ?? record.durationMs;
        record.result = item.result ?? record.result;
        if (record.evidence !== "native") {
          if (record.evidence !== "provider") record.evidence = item.evidence;
          this.transition(record, item.state);
          if (!this.fallbackStates.has(id) && this.fallbackStates.size >= 1024)
            throw new Error("Too many tracked subagents");
          this.fallbackStates.set(id, {
            state: record.state,
            historical: this.replaying,
            reopenToolId: item.reopen
              ? item.toolId
              : this.fallbackStates.get(id)?.reopenToolId,
          });
        }
        if (!record.result && ["completed", "failed"].includes(tool.status))
          record.result = preview(toolOutput(tool), 16384);
        this.toolActivity(record, tool);
        this.publish(record, removed);
      }
    }
    return true;
  }
  private toolActivity(record: ACPSubagent, update: Data) {
    const id = `tool:${update.toolCallId}`;
    let entry = record.activity.find((a) => a.id === id);
    if (!entry) {
      entry = { id, kind: "tool" };
      record.activity.push(entry);
    }
    entry.title = str(update.title, 200) ?? entry.title ?? "Delegated task";
    if (!["completed", "failed"].includes(entry.status ?? ""))
      entry.status = str(update.status, 40) ?? entry.status;
    entry.input = preview(update.rawInput) ?? entry.input;
    entry.output = preview(toolOutput(update)) ?? entry.output;
    entry.locations = Array.isArray(update.locations)
      ? update.locations
          .filter((l: any) => typeof l.path === "string")
          .slice(0, 16)
          .map((l: any) => ({
            path: l.path.slice(0, 4096),
            line: Number.isSafeInteger(l.line) ? l.line : undefined,
          }))
      : entry.locations;
  }
  private activity(sessionId: string, update: Data) {
    const id = this.idForSession(sessionId)!;
    const known = this.sessions.get(sessionId)!;
    const record =
      this.records.get(id) ?? this.create(id, this.idForSession(known.parent));
    Object.assign(record, {
      sessionId,
      evidence: "native",
      visibility: "full",
    });
    this.transition(record, known.state);
    // Terminal children can still report a final result, but never become running again.
    let phase: ACPSubagentPhase | undefined;
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
      const content =
        str(update.content?.text ?? update.content?.resource?.text, 16384) ??
        "";
      const previous = record.activity.at(-1);
      let entry = identity(update.messageId)
        ? record.activity.find(
            (a) =>
              a.kind === "message" &&
              a.id === `message:provider:${update.messageId}`,
          )
        : previous?.kind === "message" && previous.role === role
          ? previous
          : undefined;
      if (!entry) {
        entry = {
          id: identity(update.messageId)
            ? `message:provider:${update.messageId}`
            : `message:local:${++this.serial}`,
          kind: "message",
          role,
          text: "",
        };
        record.activity.push(entry);
      }
      if (entry.text!.length + content.length > 16384) record.truncated = true;
      entry.text = (entry.text + content).slice(-16384);
      if (role === "agent") {
        record.result = entry.text;
        phase = "responding";
      } else if (role === "thought") phase = "thinking";
    } else if (
      ["tool_call", "tool_call_update"].includes(update.sessionUpdate) &&
      identity(update.toolCallId)
    ) {
      this.toolActivity(record, update);
      phase = record.activity.some(
        (a) =>
          a.kind === "tool" &&
          ["pending", "in_progress"].includes(a.status ?? ""),
      )
        ? "executing_tools"
        : "unknown";
    } else return;
    if (!terminal(known.state)) {
      known.state = "running";
      known.historical = this.replaying;
      record.state = "running";
      record.phase = this.waits.get(sessionId)?.size
        ? "awaiting_input"
        : (phase ?? record.phase);
    }
    this.publish(record);
  }
  waiting(
    sessionId: string,
    requestId: string,
    waiting: boolean,
    toolId?: string,
  ) {
    const id =
      this.idForSession(sessionId) ??
      (toolId ? this.idForTool(sessionId, toolId) : undefined);
    if (!id) return;
    const key = this.idForSession(sessionId) ? sessionId : id;
    const set = this.waits.get(key) ?? new Set<string>();
    if (waiting) set.add(requestId);
    else set.delete(requestId);
    if (set.size) this.waits.set(key, set);
    else this.waits.delete(key);
    const record = this.records.get(id);
    if (record && !terminal(record.state)) {
      const native = this.sessions.get(sessionId);
      if (native) native.historical = false;
      record.phase = set.size ? "awaiting_input" : "unknown";
      this.publish(record, [], true);
    }
  }
  terminal(
    sessionId: string,
    terminalId: string,
    title: string,
    output: string,
    ended: boolean,
  ) {
    const id = this.idForSession(sessionId),
      record = id && this.records.get(id);
    if (!record) return;
    const entryId = `terminal:${terminalId}`;
    const entry = record.activity.find((a) => a.id === entryId) ?? {
      id: entryId,
      kind: "terminal" as const,
    };
    if (!record.activity.includes(entry)) record.activity.push(entry);
    Object.assign(entry, {
      title: title.slice(0, 200),
      text: output.slice(-8192),
      status: ended ? "completed" : "in_progress",
    });
    if (output.length > 8192) record.truncated = true;
    if (!terminal(record.state) && !this.waits.get(sessionId)?.size)
      record.phase = ended ? "unknown" : "executing_tools";
    this.publish(record);
  }
  disconnect() {
    for (const record of this.fallbackStates.values())
      if (!terminal(record.state)) record.state = "disconnected";
    for (const session of this.sessions.values())
      if (!terminal(session.state)) session.state = "disconnected";
    for (const record of this.records.values()) {
      if (!terminal(record.state)) {
        this.transition(record, "disconnected");
        this.publish(record);
      }
    }
  }
}
