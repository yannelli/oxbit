import { MODES } from "@oxbit/agent-core";
import type { Command, Completion } from "./complete.js";
import type { ConnectionInfo, PermissionOutcome, PermissionRequest, SessionState, SessionSummary, SessionUpdate, TuiConnection } from "./connection.js";
import { draftOf, emptyDraft, type Draft } from "./editor.js";
import { cancelOutcome, outcomeOf, ruleKey, type Decision } from "./permission.js";
import { applyStatus, emptyStatus, fromConfig, fromSession, type Status } from "./status.js";
import { append, applyUpdate, emptyTranscript, endTurn, type Item, type Transcript } from "./transcript.js";

export type Overlay =
  | { kind: "models"; filter: string; index: number }
  | { kind: "sessions"; filter: string; index: number; sessions: SessionSummary[] }
  | { kind: "help" }
  | { kind: "details"; id: number };
export interface PendingPermission { request: PermissionRequest; resolve(outcome: PermissionOutcome): void; index: number }
export interface ViewState {
  cwd: string;
  transcript: Transcript;
  draft: Draft;
  completion?: Completion;
  overlay?: Overlay;
  permission?: PendingPermission;
  running: boolean;
  startedAt?: number;
  queued: string[];
  status: Status;
  info: ConnectionInfo;
  hint?: string;
}

const STOP_NOTES: Record<string, string> = {
  cancelled: "Interrupted",
  max_tokens: "The response reached the output token limit",
  max_turn_requests: "Stopped after the maximum number of model requests",
  refusal: "The model declined to answer",
};
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Session, turn, permission and model state over a TuiConnection. */
export class SessionController {
  protected state: ViewState;
  private listeners = new Set<() => void>();
  private permissions: PendingPermission[] = [];
  private rules = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private hintTimer?: ReturnType<typeof setTimeout>;
  private early?: [string, SessionUpdate][];
  private stop: (() => void)[];
  onExit?: () => void;

  constructor(protected connection: TuiConnection, protected cwd: string) {
    this.state = { cwd, transcript: emptyTranscript(), draft: emptyDraft, running: false, queued: [], status: emptyStatus(),
      info: connection.info() };
    this.stop = [connection.onUpdate(this.onUpdate), connection.onPermission(this.onPermission)];
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getState = () => this.state;
  private notify() {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const listener of this.listeners) listener();
  }
  /** `soon` coalesces streaming updates into one render per 16 ms. */
  set(patch: Partial<ViewState>, soon = false) {
    this.state = { ...this.state, ...patch };
    if (!soon) this.notify();
    else this.timer ??= setTimeout(() => this.notify(), 16);
  }
  protected transcript(change: (transcript: Transcript) => Transcript) {
    this.set({ transcript: change(this.state.transcript) });
  }
  notice(text: string, tone: "info" | "warn" | "error" = "info") {
    this.transcript((transcript) => append(transcript, { type: "notice", text, tone }));
  }
  flash(hint: string) {
    clearTimeout(this.hintTimer);
    this.set({ hint });
    this.hintTimer = setTimeout(() => this.state.hint === hint && this.set({ hint: undefined }), 2000);
  }

  private onUpdate = (sessionId: string, update: SessionUpdate) => {
    if (this.early) return void this.early.push([sessionId, update]);
    if (sessionId !== this.state.status.sessionId) return;
    this.set({ transcript: applyUpdate(this.state.transcript, update), status: applyStatus(this.state.status, update), info: this.connection.info() }, true);
    if (update.sessionUpdate === "available_commands_update") this.commandsChanged();
  };
  protected commandsChanged() {}
  private onPermission = (request: PermissionRequest) => new Promise<PermissionOutcome>((resolve) => {
    if (this.rules.has(ruleKey(request))) return resolve(outcomeOf(request, "once").outcome);
    this.permissions.push({ request, resolve, index: 0 });
    if (this.permissions.length === 1) this.set({ permission: this.permissions[0] });
  });

  /** Opens `sessionId` (or a new session) and replays updates that arrived before the response. */
  async open(sessionId?: string, label?: string) {
    if (this.state.running) return this.notice("Wait for the agent to finish, or press Esc to stop it", "warn");
    this.rules.clear();
    if (label) this.transcript((transcript) => append(transcript, { type: "divider", text: label }));
    this.early = [];
    let session: SessionState | undefined;
    try {
      session = sessionId ? await this.connection.loadSession(sessionId, this.cwd) : await this.connection.newSession(this.cwd);
    } catch (error) {
      this.notice(message(error), "error");
    }
    const early = this.early;
    this.early = undefined;
    if (!session) return;
    this.set({ status: fromSession(session), info: this.connection.info() });
    for (const [id, update] of early) this.onUpdate(id, update);
    this.transcript(endTurn);
  }

  protected async send(text: string) {
    const sessionId = this.state.status.sessionId;
    if (!sessionId) return this.notice("There is no open session. Run /new to start one.", "error");
    this.set({ transcript: append(this.state.transcript, { type: "user", text }), running: true, startedAt: Date.now() });
    let failed: string | undefined;
    let stopReason = "end_turn";
    try {
      stopReason = (await this.connection.prompt(sessionId, [{ type: "text", text }])).stopReason;
    } catch (error) {
      failed = message(error);
    }
    let transcript = endTurn(this.state.transcript);
    if (STOP_NOTES[stopReason]) transcript = append(transcript, { type: "notice", text: STOP_NOTES[stopReason], tone: "warn" });
    if (failed) transcript = append(transcript, { type: "notice", text: failed, tone: "error" });
    const [next, ...queued] = this.state.queued;
    const draft = failed && !this.state.draft.text ? draftOf(text) : this.state.draft;
    this.set({ transcript, running: false, startedAt: undefined, info: this.connection.info(), draft, queued: failed || !next ? this.state.queued : queued });
    if (next && !failed) void this.send(next);
  }

  /** Stops the running turn; queued prompts return to the input. */
  cancel() {
    const sessionId = this.state.status.sessionId;
    for (const pending of this.permissions.splice(0)) pending.resolve(cancelOutcome());
    const queued = this.state.queued.join("\n\n");
    this.set({ permission: undefined, queued: [], ...queued && !this.state.draft.text ? { draft: draftOf(queued) } : {} });
    if (sessionId && this.state.running) void Promise.resolve(this.connection.cancel(sessionId)).catch(() => {});
  }

  decide(decision: Decision) {
    const pending = this.permissions.shift();
    if (!pending) return;
    const { outcome, remember } = outcomeOf(pending.request, decision);
    if (remember) this.rules.add(ruleKey(pending.request));
    pending.resolve(outcome);
    this.set({ permission: this.permissions[0] });
  }

  cycleMode() {
    const ids = MODES.map((mode) => mode.id as string);
    const mode = ids[(ids.indexOf(this.state.status.mode) + 1) % ids.length];
    const sessionId = this.state.status.sessionId;
    this.set({ status: { ...this.state.status, mode } });
    if (sessionId) this.connection.setMode(sessionId, mode).catch((error) => this.notice(message(error), "error"));
  }

  openModels() {
    const { models, model } = this.state.status;
    if (!models.length) return this.notice("The model list is empty. Check the provider settings.", "warn");
    this.set({ overlay: { kind: "models", filter: "", index: Math.max(0, models.findIndex((item) => item.value === model)) } });
  }

  async chooseModel(modelId: string) {
    const { status } = this.state;
    this.set({ overlay: undefined, status: { ...status, model: modelId } });
    if (!status.sessionId) return;
    try {
      const result = await this.connection.setModel(status.sessionId, modelId);
      if (result?.configOptions) this.set({ status: { ...this.state.status, ...fromConfig(result.configOptions) } });
    } catch (error) {
      this.set({ status: { ...this.state.status, model: status.model } });
      this.notice(message(error), "error");
    }
  }

  async cycleReasoning(step: 1 | -1) {
    const { reasoning, sessionId } = this.state.status;
    if (!reasoning || !sessionId || !this.connection.setConfigOption) return;
    const values = reasoning.options.map((option) => option.value);
    const value = values[(values.indexOf(reasoning.currentValue) + step + values.length) % values.length];
    this.set({ status: { ...this.state.status, reasoning: { ...reasoning, currentValue: value } } });
    try {
      const result = await this.connection.setConfigOption(sessionId, reasoning.id, value);
      if (result?.configOptions) this.set({ status: { ...this.state.status, ...fromConfig(result.configOptions) } });
    } catch (error) {
      this.notice(message(error), "error");
    }
  }

  async openSessions() {
    try {
      const sessions = (await this.connection.listSessions?.(this.cwd)) ?? [];
      if (!sessions.length) return this.notice("There are no saved sessions for this folder.");
      this.set({ overlay: { kind: "sessions", filter: "", index: 0, sessions } });
    } catch (error) {
      this.notice(message(error), "error");
    }
  }

  commands(): Command[] {
    return this.state.status.commands;
  }

  exit() {
    if (this.state.running) this.cancel();
    this.dispose();
    this.onExit?.();
  }

  dispose() {
    for (const stop of this.stop.splice(0)) stop();
    for (const pending of this.permissions.splice(0)) pending.resolve(cancelOutcome());
    clearTimeout(this.timer);
    clearTimeout(this.hintTimer);
  }

  liveTool(toolCallId: string) {
    const item = this.state.transcript.live.find((entry) => entry.type === "tool" && entry.tool.toolCallId === toolCallId);
    return (item as Extract<Item, { type: "tool" }> | undefined)?.tool;
  }
}
