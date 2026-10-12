import type { AgentModelApi, AgentModelEndpoint, AgentModels } from "@oxbit/sdk";
import type { Effort, ModelAdapter, ModelInfo, ToolResult, Turn } from "./model.js";
import { builtinTools, runTool } from "./tools.js";
import { openaiResponses } from "./openai-responses.js";
import { chatCompletions } from "./chat-completions.js";
import { anthropicMessages } from "./anthropic-messages.js";
import { streamStep } from "./step.js";
import { hookGate } from "./tool-gate.js";
import { modeOf } from "./session-records.js";
import { COMPACT_FOCUS } from "./compaction.js";
import type { AgentHost } from "./host.js";
import type { AgentTool, HookEvent, HookOutcome, Params, SessionView } from "./extensions.js";

export interface LiveSession extends SessionView {
  turns: Turn[];
  effort: Effort | "default";
  catalog: ModelInfo[];
  /** SessionStart additionalContext for the system prompt. */
  context: string[];
  commands?: string;
  /** Title generation ran or does not apply. */
  titled?: boolean;
  abort?: AbortController;
}
type Summarize = (system: string, turns: Turn[]) => Promise<string>;

export const ADAPTERS: Record<AgentModelApi, ModelAdapter> = {
  openai: openaiResponses,
  "openai-compatible": chatCompletions,
  anthropic: anthropicMessages,
};
const MAX_STEPS = 64;
export const CONTEXT_LIMIT = 10000;
const system = (root: string, reviewed: boolean, shell: boolean) => [
  `You are Oxbit Agent, a coding agent inside the Oxbit editor. You work in the workspace "${root.split("/").pop()}" through tools.`,
  "Paths are relative to the workspace root. Read a file before you edit it. edit_file replaces an exact string; write_file replaces a whole file.",
  ...reviewed ? ["The user reviews each write before it is saved; a rejected write returns an error, so ask what to change instead of retrying it."] : [],
  ...shell ? ["Run shell commands with bash. Use the file tools to read and edit files."] : [],
  "Use update_plan for work with several steps. Keep replies short and use Markdown.",
].join("\n");
export const normalize = (cwd: string) => cwd.replace(/\/+$/, "") || "/";
const CLAUDE_PERMISSION_MODES = { "ask": "default", "accept-edits": "acceptEdits", "full-auto": "bypassPermissions" } as const;

/** One prompt turn of a session: the model and tool loop with every extension call site. */
export class PromptTurn {
  /** Set by a hook that returns continue: false. */
  halt?: string;
  private stopHookActive = false;
  private snapshotted = false;
  constructor(private host: AgentHost, private session: LiveSession, readonly signal: AbortSignal) {}
  async hook(event: HookEvent, input: Params): Promise<HookOutcome> {
    const runner = this.host.extensions?.hooks;
    if (!runner) return {};
    const outcome = await runner.run(event, { session_id: this.session.id, cwd: this.session.cwd, hook_event_name: event,
      permission_mode: CLAUDE_PERMISSION_MODES[modeOf(this.session.meta)], ...input }, this.signal);
    if (outcome.systemMessage) this.notice(outcome.systemMessage);
    if (outcome.continue === false) this.halt ??= outcome.stopReason || "A hook stopped the agent";
    return outcome;
  }
  notice(text: string) {
    this.host.update(this.session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n${text}\n\n` } });
  }
  halted() {
    this.notice(this.halt!);
    return { stopReason: "end_turn" };
  }
  /** Built-in tools, then provider tools whose names are not taken. */
  async tools() {
    const provided = await Promise.all((this.host.extensions?.tools ?? []).map((provider) => provider.tools(this.session)));
    const tools: AgentTool[] = [...builtinTools(this.host.capabilities)];
    for (const tool of provided.flat()) if (!tools.some((item) => item.spec.name === tool.spec.name)) tools.push(tool);
    return tools;
  }
  private async system() {
    const sections = await Promise.all((this.host.extensions?.context ?? []).map((provider) => provider.system(this.session)));
    const base = system(this.session.cwd, this.host.capabilities.fs, this.host.capabilities.terminal);
    return [base, ...this.session.context, ...sections].filter((section) => !!section).join("\n\n");
  }
  async run(models: AgentModels, endpoint: AgentModelEndpoint): Promise<{ stopReason: string }> {
    const { session, signal } = this;
    const update = (value: Params) => this.host.update(session.id, value);
    const adapter = ADAPTERS[endpoint.api] as ModelAdapter | undefined;
    if (!adapter) throw new Error(`Choose a model API in Agent setup: ${endpoint.api} is not supported`);
    const info = session.catalog.find((model) => model.id === session.model);
    const prompt = await this.system();
    const gate = hookGate({ sessionId: session.id, hook: (event, input) => this.hook(event, input),
      request: (method, params) => this.host.request(method, params), mode: () => modeOf(session.meta), snapshot: (label) => this.snapshot(label) });
    let usage = { input: 0, output: 0 };
    let steps = 0;
    while (steps++ < MAX_STEPS) {
      const tools = await this.tools();
      this.snapshotted = false;
      const result = await streamStep({ adapter, models, endpoint, signal, update, turns: session.turns, contextWindow: info?.contextWindow,
        input: { model: session.model, system: prompt, turns: session.turns, tools: tools.map((tool) => tool.spec),
          effort: session.effort === "default" ? undefined : session.effort, maxTokens: info?.maxOutput } });
      usage = result.usage ?? usage;
      const calls = result.turn.calls;
      const context = { root: session.cwd, sessionId: session.id, mode: modeOf(session.meta), signal, update,
        request: (method: string, params: Params) => this.host.request(method, params),
        filesystem: session.cwd === normalize(this.host.root) ? this.host.filesystem : this.host.filesystemFor!(session.cwd) };
      const results: ToolResult[] = [];
      for (const call of calls) {
        const skipped = signal.aborted ? "Cancelled by the user" : this.halt;
        results.push(skipped ? { id: call.id, name: call.name, output: skipped, error: true } : await runTool(call, context, tools, gate));
      }
      if (results.length) session.turns.push({ role: "tool", results });
      if (signal.aborted) return { stopReason: "cancelled" };
      try {
        const compactor = this.host.extensions?.compactor;
        if (!this.halt && compactor?.shouldCompact(session, usage, info?.contextWindow, info?.maxOutput) &&
          await this.compact("auto", this.summarizer(adapter, models, endpoint)))
          this.notice("Compacted the conversation to stay within the context window.");
      } catch (error) {
        if (signal.aborted) return { stopReason: "cancelled" };
        throw error;
      }
      if (this.halt) return this.halted();
      if (calls.length) continue;
      const next = result.stop === "end_turn" || result.stop === "tool_use" ? await this.afterStop() : undefined;
      if (signal.aborted) return { stopReason: "cancelled" };
      if (this.halt) return this.halted();
      if (next === undefined) return { stopReason: result.stop === "tool_use" ? "end_turn" : result.stop! };
      session.turns.push({ role: "user", text: next });
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: next } });
      // Each continuation gets a full step budget; goal and loop cap their own runs.
      steps = 0;
    }
    return { stopReason: "max_turn_requests" };
  }
  /** Stop hooks, then continuation providers. Returns the text of the next user message, if any. */
  private async afterStop() {
    const last = this.session.turns.at(-1);
    const outcome = await this.hook("Stop", { stop_hook_active: this.stopHookActive, last_assistant_message: last?.role === "assistant" ? last.text : "" });
    if (this.halt) return undefined;
    if (outcome.block) {
      this.stopHookActive = true;
      return outcome.reason || "A stop hook asked you to continue.";
    }
    for (const provider of this.host.extensions?.continuations ?? []) {
      const text = await provider.next(this.session, this.signal);
      if (text) return text;
    }
    return undefined;
  }
  /** The compactor sends older turns as one transcript message, so the request carries no tools. */
  summarizer(adapter: ModelAdapter, models: AgentModels, endpoint: AgentModelEndpoint): Summarize {
    return async (prompt, turns) => {
      const result = await streamStep({ adapter, models, endpoint, signal: this.signal, update: () => {}, turns: [],
        input: { model: this.session.model, system: prompt, turns, tools: [] } });
      if (!result.stop) throw new Error("Cancelled");
      return result.turn.text;
    };
  }
  /** PreCompact, the compactor, PostCompact. Resolves false when there is no compactor or a hook blocks it. */
  async compact(trigger: "auto" | "manual", summarize: Summarize) {
    const compactor = this.host.extensions?.compactor;
    if (!compactor) return false;
    const focus = this.session.meta[COMPACT_FOCUS];
    const before = await this.hook("PreCompact", { trigger, custom_instructions: typeof focus === "string" ? focus : "" });
    if (before.block || this.halt) return false;
    this.session.turns = await compactor.compact(this.session, summarize, this.signal);
    await this.hook("PostCompact", { trigger });
    return true;
  }
  private async snapshot(label: string) {
    const store = this.host.extensions?.snapshots;
    if (!store || this.snapshotted) return;
    this.snapshotted = true;
    const snapshot = await store.capture(label);
    const list = Array.isArray(this.session.meta.snapshots) ? this.session.meta.snapshots : [];
    if (snapshot) this.session.meta.snapshots = [...list, { id: snapshot, label, turn: this.session.turns.length }];
  }
}
