import { MODES } from "@oxbit/agent-core";
import type { ConfigOption, ConnectionInfo, PermissionOutcome, PermissionRequest, PromptBlock, SessionState, SessionSummary, SessionUpdate, TuiConnection } from "./connection.js";

export interface ScriptContext {
  sessionId: string;
  text: string;
  signal: AbortSignal;
  update(update: SessionUpdate): void;
  /** Sends session/request_permission with the agent's allow and reject options. */
  permission(toolCall: PermissionRequest["toolCall"]): Promise<PermissionOutcome>;
  /** Resolves after `ms`, or early when the turn is cancelled. */
  sleep(ms: number): Promise<void>;
}
/** One scripted prompt turn; returns the stop reason (default end_turn). */
export type Script = (context: ScriptContext) => Promise<string | void>;
export interface FakeOptions {
  info?: ConnectionInfo;
  commands?: { name: string; description: string; input?: { hint: string } }[];
  models?: { id: string; name: string }[];
  files?: string[];
  sessions?: SessionSummary[];
}

const OPTIONS = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];

/** A TuiConnection that replays scripted session/update notifications, for tests and the demo. */
export class FakeConnection implements TuiConnection {
  prompts: string[] = [];
  modes: string[] = [];
  models: string[] = [];
  cancels = 0;
  outcomes: PermissionOutcome[] = [];
  private listeners = new Set<(sessionId: string, update: SessionUpdate) => void>();
  private handler?: (request: PermissionRequest) => Promise<PermissionOutcome>;
  private abort?: AbortController;
  private count = 0;
  private model: string;
  private effort = "default";
  private mode = "ask";

  constructor(public scripts: Script[] = [], private options: FakeOptions = {}) {
    this.model = this.catalog()[0].id;
  }
  private catalog() {
    return this.options.models ?? [{ id: "gpt-5.1", name: "GPT-5.1" }, { id: "gpt-5.1-mini", name: "GPT-5.1 mini" }];
  }
  private config(): ConfigOption[] {
    return [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: this.model, options: this.catalog().map((model) => ({ value: model.id, name: model.name })) },
      { id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", currentValue: this.effort,
        options: ["default", "low", "medium", "high"].map((value) => ({ value, name: value === "default" ? "Model default" : value })) },
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: this.mode, options: MODES.map(({ id, name }) => ({ value: id, name })) },
    ];
  }
  private state(sessionId: string): SessionState {
    return {
      sessionId,
      models: { currentModelId: this.model, availableModels: this.catalog().map((model) => ({ modelId: model.id, name: model.name })) },
      modes: { currentModeId: this.mode, availableModes: MODES },
      configOptions: this.config(),
    };
  }
  emit(sessionId: string, update: SessionUpdate) {
    for (const listener of this.listeners) listener(sessionId, update);
  }
  info() {
    return this.options.info ?? { provider: "openai" };
  }
  async newSession() {
    const sessionId = `session-${++this.count}`;
    setTimeout(() => this.emit(sessionId, { sessionUpdate: "available_commands_update", availableCommands: this.options.commands ?? [] }), 0);
    return this.state(sessionId);
  }
  async loadSession(sessionId: string) {
    this.emit(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Earlier question" } });
    this.emit(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Earlier answer." } });
    return this.state(sessionId);
  }
  async listSessions() {
    return this.options.sessions ?? [];
  }
  async prompt(sessionId: string, prompt: PromptBlock[]) {
    const text = prompt.map((block) => block.text).join("\n");
    this.prompts.push(text);
    const script = this.scripts.shift();
    const abort = this.abort = new AbortController();
    const signal = abort.signal;
    const context: ScriptContext = {
      sessionId, text, signal,
      update: (update) => this.emit(sessionId, update),
      permission: async (toolCall) => {
        const outcome = await this.handler!({ sessionId, options: OPTIONS, toolCall });
        this.outcomes.push(outcome);
        return outcome;
      },
      sleep: (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      }),
    };
    if (!script) {
      context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
      return { stopReason: "end_turn" };
    }
    const reason = await script(context);
    return { stopReason: signal.aborted ? "cancelled" : reason || "end_turn" };
  }
  cancel() {
    this.cancels++;
    this.abort?.abort();
  }
  async setMode(sessionId: string, modeId: string) {
    this.modes.push(modeId);
    this.mode = modeId;
    this.emit(sessionId, { sessionUpdate: "current_mode_update", currentModeId: modeId });
  }
  async setModel(_sessionId: string, modelId: string) {
    this.models.push(modelId);
    this.model = modelId;
    return { configOptions: this.config() };
  }
  async setConfigOption(_sessionId: string, configId: string, value: string) {
    if (configId === "reasoning") this.effort = value;
    return { configOptions: this.config() };
  }
  onUpdate(listener: (sessionId: string, update: SessionUpdate) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  onPermission(handler: (request: PermissionRequest) => Promise<PermissionOutcome>) {
    this.handler = handler;
    return () => void (this.handler = undefined);
  }
  async listFiles(query: string) {
    return (this.options.files ?? []).filter((path) => path.toLowerCase().includes(query.toLowerCase().replace(/^.*\//, "")) || !query);
  }
}

/** Streams `text` as agent_message_chunk updates of `size` characters. */
export async function streamText(context: ScriptContext, text: string, size = 12, delay = 5) {
  for (let index = 0; index < text.length && !context.signal.aborted; index += size) {
    context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.slice(index, index + size) } });
    await context.sleep(delay);
  }
}
