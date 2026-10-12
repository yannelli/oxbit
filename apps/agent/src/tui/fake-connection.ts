import { MODES } from "@oxbit/agent-core";
import type { ConfigOption, ConnectionInfo, Panel, PanelChange, PanelContext, PanelId, PanelRow, PermissionOutcome, PermissionRequest, PromptBlock, SessionState,
  SessionSummary, SessionUpdate, SettingsManager, TuiConnection } from "./connection.js";

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
  settings?: FakeSettings;
}

const OPTIONS = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];

/** A TuiConnection that replays scripted session/update notifications, for tests and the demo. */
export class FakeConnection implements TuiConnection {
  prompts: string[] = [];
  loads: string[] = [];
  /** Session ids loadSession rejects, as for a session that was never saved. */
  unknown = new Set<string>();
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

  settings?: FakeSettings;

  constructor(public scripts: Script[] = [], private options: FakeOptions = {}) {
    this.model = this.catalog()[0].id;
    this.settings = options.settings;
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
  info(): ConnectionInfo {
    const info = this.options.info ?? { provider: "openai" };
    return this.settings?.provider ? { ...info, provider: this.settings.provider } : info;
  }
  async newSession() {
    const sessionId = `session-${++this.count}`;
    setTimeout(() => this.emit(sessionId, { sessionUpdate: "available_commands_update", availableCommands: this.options.commands ?? [] }), 0);
    return this.state(sessionId);
  }
  async loadSession(sessionId: string) {
    this.loads.push(sessionId);
    if (this.unknown.has(sessionId)) throw new Error(`Unknown ACP session ${sessionId}`);
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

const TITLES: Record<PanelId, string> = { config: "Settings", skills: "Skills", hooks: "Hooks", mcp: "MCP servers", instructions: "Instructions", providers: "Providers" };
const SIGN_IN = "Open https://auth.example.com/device?code=WXYZ-1234&client=oxbit-agent-cli in a browser to sign in";

/** A SettingsManager with toggles, a mode choice, actions with inputs, a sign-in that reports progress, and calls recorded in `calls`. */
export class FakeSettings implements SettingsManager {
  calls: string[] = [];
  contexts: PanelContext[] = [];
  aborted = 0;
  provider?: string;
  private mode = "ask";
  private enabled: Record<string, boolean> = { autoCompact: true, claudeHooks: false, projectMcp: true, review: true, deploy: false,
    oxbit: true, claude: false, agents: true, claudeMd: false, github: true };
  private servers = ["github"];

  private rows(id: PanelId): PanelRow[] {
    const toggle = (rowId: string, label: string, section?: string, detail?: string): PanelRow => ({ id: rowId, label, section, detail, enabled: this.enabled[rowId] });
    switch (id) {
      case "config": return [
        toggle("autoCompact", "Auto-compact", "Session", "summarize when the context is full"),
        { id: "mode", label: "Permission mode", section: "Session", choice: { value: this.mode, options: MODES.map(({ id: value, name }) => ({ value, name })) } },
        toggle("claudeHooks", "Claude Code hooks", "Trust"),
        toggle("projectMcp", "Project MCP servers", "Trust", ".mcp.json")];
      case "skills": return [
        { ...toggle("review", "review", "Skills", "Review the current diff"), actions: [{ id: "use", label: "Use in prompt" }] },
        toggle("deploy", "deploy", "Skills", "Ship a release")];
      case "hooks": return [toggle("oxbit", "~/.oxbit/agent/settings.json", "Sources", "2 hooks"), toggle("claude", "~/.claude/settings.json", "Sources", "1 hook")];
      case "instructions": return [toggle("agents", "AGENTS.md", "Project"), toggle("claudeMd", "~/.claude/CLAUDE.md", "User")];
      case "mcp": return [
        ...this.servers.map((name) => ({ ...toggle(name, name, "Servers", `https://mcp.example.com/${name}`),
          actions: [{ id: "signin", label: "Sign in" }, { id: "remove", label: "Remove", reloads: true }] })),
        { id: "add", label: "Add a server…", section: "Add", actions: [{ id: "add", label: "Add a server", reloads: true,
          inputs: [{ label: "Name", placeholder: "linear" }, { label: "URL", placeholder: "https://" }] }] }];
      case "providers": return [
        { id: "openai", label: "OpenAI", section: "Providers", detail: this.provider ? "" : "default", actions: [
          { id: "signin", label: "Sign in with ChatGPT" }, { id: "key", label: "Set API key", reloads: true, inputs: [{ label: "API key", secret: true, placeholder: "sk-…" }] }] },
        { id: "custom", label: "Custom", section: "Providers", detail: this.provider === "custom" ? "default" : "", actions: [{ id: "connect", label: "Connect", reloads: true,
          inputs: [{ label: "Base URL", value: "https://api.example.com/v1" }, { label: "API key", secret: true, placeholder: "sk-…" }] }] }];
    }
  }

  async panel(id: PanelId, context: PanelContext): Promise<Panel> {
    this.calls.push(`panel ${id}`);
    this.contexts.push(context);
    return { id, title: TITLES[id], rows: this.rows(id), ...id === "config" ? { footer: "Saved to ~/.oxbit/agent/settings.json" } : {} };
  }
  async toggle(id: PanelId, rowId: string, enabled: boolean): Promise<PanelChange> {
    this.calls.push(`toggle ${id} ${rowId} ${enabled}`);
    this.enabled[rowId] = enabled;
    return {};
  }
  async choose(id: PanelId, rowId: string, value: string): Promise<PanelChange> {
    this.calls.push(`choose ${id} ${rowId} ${value}`);
    this.mode = value;
    return { mode: value };
  }
  async act(id: PanelId, rowId: string, actionId: string, inputs: string[], context: PanelContext): Promise<PanelChange> {
    this.calls.push(`act ${id} ${rowId} ${actionId} ${JSON.stringify(inputs)}`);
    if (actionId === "use" && id === "providers") {
      this.provider = rowId;
      return { reloaded: true, message: `Using ${rowId}` };
    }
    if (actionId === "use") return { draft: `/${rowId} ` };
    if (actionId === "signin") {
      context.progress(SIGN_IN);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 3000);
        context.signal.addEventListener("abort", () => { clearTimeout(timer); this.aborted++; reject(new Error("Cancelled")); }, { once: true });
      });
      return { message: "Signed in" };
    }
    if (actionId === "add") this.servers.push(inputs[0]);
    if (actionId === "remove") this.servers = this.servers.filter((name) => name !== rowId);
    if (actionId === "connect") this.provider = "custom";
    return { reloaded: true, message: actionId === "connect" ? "Connected to the custom provider" : "Saved" };
  }
}
