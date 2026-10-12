import { OXBIT_AGENT_SETTINGS, type ACPConfigOption, type AgentModelApi, type AgentModelEndpoint, type AgentModels, type ConfigurationService, type FileSystem } from "@oxbit/sdk";
import { listModels, modelError, type Effort, type ModelAdapter, type ModelInfo, type StopReason, type ToolCall, type Turn } from "./model.js";
import { TOOLS, runTool } from "./tools.js";
import { openaiResponses } from "./openai-responses.js";
import { chatCompletions } from "./chat-completions.js";
import { anthropicMessages } from "./anthropic-messages.js";

type Params = Record<string, any>;
export interface AgentHost {
  models(): AgentModels | undefined;
  endpoint(): AgentModelEndpoint;
  configuration?: ConfigurationService;
  filesystem: FileSystem;
  root: string;
  update(sessionId: string, update: Params): void;
  request(method: string, params: Params): Promise<any>;
}
interface Session {
  id: string;
  turns: Turn[];
  model: string;
  effort: Effort | "default";
  catalog: ModelInfo[];
  abort?: AbortController;
}

const ADAPTERS: Record<AgentModelApi, ModelAdapter> = {
  openai: openaiResponses,
  "openai-compatible": chatCompletions,
  anthropic: anthropicMessages,
};
const MAX_STEPS = 64;
const EFFORTS = ["default", "low", "medium", "high"] as const;
const system = (root: string) => `You are Oxbit Agent, a coding agent inside the Oxbit editor. You work in the workspace "${root.split("/").pop()}" through tools.
Paths are relative to the workspace root. Read a file before you edit it. edit_file replaces an exact string; write_file replaces a whole file.
The user reviews each write before it is saved; a rejected write returns an error, so ask what to change instead of retrying it.
Use update_plan for work with several steps. Keep replies short and use Markdown.`;

/** Ends iteration when `signal` aborts, even if the host stream ignores the signal. */
async function* abortable<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("Cancelled"));
    else signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void iterator.return?.()?.catch(() => {});
  }
}

/** Text of ACP prompt blocks: text, and embedded resources from attached editor context. */
const promptText = (blocks: Params[]) =>
  blocks.map((block) => block.type === "text" ? block.text : block.type === "resource" ? block.resource?.text : undefined)
    .filter((text): text is string => typeof text === "string" && !!text).join("\n\n");

/** An ACP agent that runs in the app and calls a model API through the host's AgentModels service. */
export class LocalAgent {
  private sessions = new Map<string, Session>();
  private catalog?: Promise<ModelInfo[]>;
  constructor(private host: AgentHost) {}
  initialize() {
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { fork: {} }, promptCapabilities: { embeddedContext: true } },
      agentInfo: { name: "oxbit", title: "Oxbit Agent" },
      authMethods: [],
    };
  }
  private service() {
    const models = this.host.models();
    if (!models) throw new Error("The model service is unavailable in this workspace");
    return models;
  }
  private session(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown ACP session");
    return session;
  }
  private options(session: Session) {
    const models: ACPConfigOption = { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model,
      options: session.catalog.map((model) => ({ value: model.id, name: model.name })) };
    const reasoning: ACPConfigOption = { id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", currentValue: session.effort,
      options: EFFORTS.map((value) => ({ value, name: value === "default" ? "Model default" : value[0].toUpperCase() + value.slice(1) })) };
    return session.catalog.length ? [models, reasoning] : [reasoning];
  }
  private state(session: Session) {
    return {
      sessionId: session.id,
      ...(session.catalog.length ? { models: { currentModelId: session.model,
        availableModels: session.catalog.map((model) => ({ modelId: model.id, name: model.name })) } } : {}),
      configOptions: this.options(session),
    };
  }
  async newSession() {
    const models = this.service();
    const endpoint = this.host.endpoint();
    const saved = this.host.configuration?.get<string>(OXBIT_AGENT_SETTINGS.model)?.trim() ?? "";
    const listed = this.catalog ??= listModels(models, endpoint);
    let catalog = await listed.catch(() => {
      if (this.catalog === listed) this.catalog = undefined;
      return [];
    });
    if (saved && !catalog.some((model) => model.id === saved)) catalog = [{ id: saved, name: saved }, ...catalog];
    for (const [id, session] of this.sessions) if (!session.abort) this.sessions.delete(id);
    const session: Session = { id: crypto.randomUUID(), turns: [], model: saved || catalog[0]?.id || "", effort: "default", catalog };
    this.sessions.set(session.id, session);
    return this.state(session);
  }
  /** A new session with a copy of the source's turns. Like newSession, it drops the other idle sessions. */
  forkSession(sessionId: string) {
    const source = this.session(sessionId);
    if (source.abort) throw new Error("Wait for the agent to finish before forking");
    const session: Session = { ...source, id: crypto.randomUUID(), turns: structuredClone(source.turns) };
    for (const [id, other] of this.sessions) if (!other.abort) this.sessions.delete(id);
    this.sessions.set(session.id, session);
    return this.state(session);
  }
  setModel(sessionId: string, modelId: string) {
    const session = this.session(sessionId);
    if (!session.catalog.some((model) => model.id === modelId)) throw new Error("This model is not in the model list");
    session.model = modelId;
    this.host.configuration?.set(OXBIT_AGENT_SETTINGS.model, modelId, "user");
    return { configOptions: this.options(session) };
  }
  setConfigOption(sessionId: string, configId: string, value: string) {
    const session = this.session(sessionId);
    if (configId === "model") return this.setModel(sessionId, value);
    if (configId !== "reasoning" || !EFFORTS.includes(value as Effort)) throw new Error("Unknown agent setting");
    session.effort = value as Effort | "default";
    return { configOptions: this.options(session) };
  }
  cancel(sessionId?: string) {
    for (const session of this.sessions.values())
      if (!sessionId || session.id === sessionId) session.abort?.abort();
  }
  async prompt(sessionId: string, blocks: Params[]): Promise<{ stopReason: string }> {
    const session = this.session(sessionId);
    if (session.abort) throw new Error("Wait for the current agent operation or stop it first");
    if (!session.model) throw new Error("Choose a model in Agent setup");
    const models = this.service();
    const endpoint = this.host.endpoint();
    const abort = new AbortController();
    session.abort = abort;
    const start = session.turns.push({ role: "user", text: promptText(blocks) });
    try {
      return await this.run(session, models, endpoint, abort.signal);
    } catch (error) {
      // The controller restores the draft after a failure; drop the turn so a resend does not repeat it.
      if (session.turns.length === start) session.turns.pop();
      throw error;
    } finally {
      session.abort = undefined;
    }
  }
  private async run(session: Session, models: AgentModels, endpoint: AgentModelEndpoint, signal: AbortSignal) {
    const update = (value: Params) => this.host.update(session.id, value);
    const adapter = ADAPTERS[endpoint.api] as ModelAdapter | undefined;
    if (!adapter) throw new Error(`Choose a model API in Agent setup: ${endpoint.api} is not supported`);
    const info = session.catalog.find((model) => model.id === session.model);
    for (let step = 0; step < MAX_STEPS; step++) {
      const calls: ToolCall[] = [];
      const turn: Extract<Turn, { role: "assistant" }> = { role: "assistant", text: "", calls };
      let stop: StopReason | undefined;
      try {
        const request = adapter.request({ model: session.model, system: system(this.host.root), turns: session.turns, tools: TOOLS,
          effort: session.effort === "default" ? undefined : session.effort, maxTokens: info?.maxOutput });
        for await (const event of adapter.events(abortable(models.stream({ ...endpoint, ...request }, signal), signal))) {
          if (event.type === "text") {
            turn.text += event.text;
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } });
          } else if (event.type === "reasoning")
            update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } });
          else if (event.type === "tool_call") calls.push(event.call);
          else if (event.type === "usage" && info?.contextWindow)
            update({ sessionUpdate: "usage_update", used: event.input + event.output, size: info.contextWindow });
          else if (event.type === "stop") {
            stop = event.reason;
            if (event.native) turn.native = { api: endpoint.api, items: event.native };
          }
        }
        if (!stop && !signal.aborted) throw new Error("The model stream ended before the response finished");
      } catch (error) {
        if (!signal.aborted) throw modelError(error);
      } finally {
        // Calls from an unfinished response never run and lack the API's reasoning items.
        if (!stop) calls.length = 0;
        if (turn.text || calls.length) session.turns.push(turn);
      }
      const context = { root: this.host.root, sessionId: session.id, filesystem: this.host.filesystem, signal,
        request: (method: string, params: Params) => this.host.request(method, params), update };
      const results = [];
      for (const call of calls)
        results.push(signal.aborted ? { id: call.id, name: call.name, output: "Cancelled by the user", error: true } : await runTool(call, context));
      if (results.length) session.turns.push({ role: "tool", results });
      if (signal.aborted) return { stopReason: "cancelled" };
      if (!calls.length) return { stopReason: stop === "tool_use" ? "end_turn" : stop! };
    }
    return { stopReason: "max_turn_requests" };
  }
}
