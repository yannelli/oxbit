import type { ACPConfigOption } from "@oxbit/sdk";
import { listModels, type ModelInfo, type Turn } from "./model.js";
import { effortLabel, modelEfforts } from "./efforts.js";
import { MODES, modeOf, replay, toRecord } from "./session-records.js";
import { generateTitle, titleInput } from "./title.js";
import { ADAPTERS, CONTEXT_LIMIT, PromptTurn, normalize, type LiveSession } from "./turn.js";
import { contextCommand } from "./context-command.js";
import type { AgentHost } from "./host.js";
import type { AgentCommand, CommandContext, Params, PermissionMode } from "./extensions.js";

const COMMAND = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/;
const id = (params: Params, key: string) => {
  if (typeof params[key] !== "string" || !params[key]) throw new Error(`Invalid ${key}`);
  return params[key] as string;
};

/** Text of ACP prompt blocks: text, and embedded resources from attached editor context. */
const promptText = (blocks: Params[]) =>
  blocks.map((block) => block.type === "text" ? block.text : block.type === "resource" ? block.resource?.text : undefined)
    .filter((text): text is string => typeof text === "string" && !!text).join("\n\n");

/** An ACP agent that calls a model API through the host's AgentModels service. */
export class Agent {
  private sessions = new Map<string, LiveSession>();
  private catalog?: Promise<ModelInfo[]>;
  constructor(private host: AgentHost) {}
  initialize() {
    const saved = !!this.host.extensions?.sessions;
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: saved, sessionCapabilities: { fork: {}, ...saved ? { list: {} } : {} }, promptCapabilities: { embeddedContext: true },
        ...this.host.capabilities.mcp ? { mcpCapabilities: this.host.capabilities.mcp } : {} },
      agentInfo: { name: "oxbit", title: "Oxbit Agent" },
      authMethods: [],
    };
  }
  /** Dispatches an ACP agent method. */
  async handle(method: string, params: Params = {}): Promise<unknown> {
    switch (method) {
      case "initialize": return this.initialize();
      case "session/new": return this.newSession(params);
      case "session/load": return this.loadSession(params);
      case "session/list": return this.listSessions(params);
      case "session/fork": return this.forkSession(id(params, "sessionId"));
      case "session/prompt": return this.prompt(id(params, "sessionId"), Array.isArray(params.prompt) ? params.prompt : []);
      case "session/set_model": return this.setModel(id(params, "sessionId"), id(params, "modelId"));
      case "session/set_mode": return this.setMode(id(params, "sessionId"), id(params, "modeId"));
      case "session/set_config_option": return this.setConfigOption(id(params, "sessionId"), id(params, "configId"), id(params, "value"));
      case "session/cancel": return this.cancel(id(params, "sessionId"));
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
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
  /** The session model's reasoning levels; empty when the model has no reasoning control. */
  private efforts(session: LiveSession) {
    const model = session.catalog.find((item) => item.id === session.model) ?? { id: session.model, name: session.model };
    return modelEfforts(this.host.endpoint().api, model);
  }
  /** A model without reasoning levels gets no Reasoning option. */
  private options(session: LiveSession) {
    const models: ACPConfigOption = { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model,
      options: session.catalog.map((model) => ({ value: model.id, name: model.name })) };
    const efforts = this.efforts(session);
    const reasoning: ACPConfigOption = { id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", currentValue: session.effort,
      options: [{ value: "default", name: "Model default" }, ...efforts.map((value) => ({ value, name: effortLabel(value) }))] };
    const mode: ACPConfigOption = { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: modeOf(session.meta),
      options: MODES.map(({ id, name }) => ({ value: id, name })) };
    return [...session.catalog.length ? [models] : [], ...efforts.length ? [reasoning] : [], mode, ...this.host.configOptions?.(session) ?? []];
  }
  private state(session: LiveSession) {
    return {
      sessionId: session.id,
      ...(session.catalog.length ? { models: { currentModelId: session.model,
        availableModels: session.catalog.map((model) => ({ modelId: model.id, name: model.name })) } } : {}),
      modes: { currentModeId: modeOf(session.meta), availableModes: MODES },
      configOptions: this.options(session),
    };
  }
  private cwd(input: unknown) {
    if (input === undefined || input === null) return normalize(this.host.root);
    if (typeof input !== "string" || !input.startsWith("/") || input.includes("\0")) throw new Error("cwd must be an absolute path");
    const cwd = normalize(input);
    if (cwd !== normalize(this.host.root) && !this.host.filesystemFor) throw new Error(`This agent serves ${this.host.root} only`);
    return cwd;
  }
  /** The host catalog or `listModels`, with `model` first when the list lacks it. */
  private async models(model: string) {
    const listed = this.host.catalog ? Promise.resolve().then(() => this.host.catalog!()) : this.catalog ??= listModels(this.service(), this.host.endpoint());
    const catalog = await listed.catch(() => {
      if (this.catalog === listed) this.catalog = undefined;
      return [];
    });
    return model && !catalog.some((item) => item.id === model) ? [{ id: model, name: model }, ...catalog] : catalog;
  }
  async newSession(params: Params = {}) {
    const cwd = this.cwd(params.cwd);
    this.service();
    const saved = this.host.model?.()?.trim() ?? "";
    const catalog = await this.models(saved);
    this.dropIdle();
    return this.open({ id: crypto.randomUUID(), cwd, turns: [], model: saved || catalog[0]?.id || "", effort: "default", catalog,
      meta: { mode: "ask", mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [] }, context: [] }, "startup");
  }
  /** Replays a saved session as session/update notifications, then opens it. */
  async loadSession(params: Params) {
    const store = this.host.extensions?.sessions;
    if (!store) throw new Error("This agent does not save sessions");
    const sessionId = id(params, "sessionId");
    if (this.sessions.get(sessionId)?.abort) throw new Error("Wait for the agent to finish before loading this session");
    const record = await store.load(sessionId);
    if (!record) throw new Error("Unknown ACP session");
    this.service();
    const catalog = await this.models(record.model);
    const meta = { ...record.meta, ...Array.isArray(params.mcpServers) ? { mcpServers: params.mcpServers } : {} };
    const session: LiveSession = { id: sessionId, cwd: this.cwd(params.cwd ?? record.cwd), turns: record.turns, model: record.model || catalog[0]?.id || "",
      effort: "default", catalog, meta, context: [], titled: record.turns.length > 0 };
    const tools = await new PromptTurn(this.host, session, new AbortController().signal).tools();
    replay(session.turns, tools, (update) => this.host.update(sessionId, update));
    return this.open(session, "resume");
  }
  async listSessions(params: Params = {}) {
    const store = this.host.extensions?.sessions;
    if (!store) throw new Error("This agent does not save sessions");
    const records = await store.list(normalize(typeof params.cwd === "string" ? params.cwd : this.host.root));
    return { sessions: records.map((record) => ({ sessionId: record.id, cwd: record.cwd, title: record.title, updatedAt: record.updatedAt })) };
  }
  private async open(session: LiveSession, source: "startup" | "resume") {
    const start = await new PromptTurn(this.host, session, new AbortController().signal).hook("SessionStart", { source, model: session.model });
    if (start.additionalContext) session.context.push(start.additionalContext.slice(0, CONTEXT_LIMIT));
    this.sessions.set(session.id, session);
    setTimeout(() => void this.publishCommands(session), 0);
    return this.state(session);
  }
  /** A new session with a copy of the source's turns. Like newSession, it drops the other idle sessions. */
  forkSession(sessionId: string) {
    const source = this.session(sessionId);
    if (source.abort) throw new Error("Wait for the agent to finish before forking");
    const session: LiveSession = { ...source, id: crypto.randomUUID(), turns: structuredClone(source.turns), meta: structuredClone(source.meta),
      context: [...source.context], commands: undefined };
    this.dropIdle();
    this.sessions.set(session.id, session);
    setTimeout(() => void this.publishCommands(session), 0);
    return this.state(session);
  }
  /** Without a SessionStore an idle session cannot be loaded again, so a new session replaces it. */
  private dropIdle() {
    if (this.host.extensions?.sessions) return;
    for (const [sessionId, session] of this.sessions) {
      if (session.abort) continue;
      this.sessions.delete(sessionId);
      void this.end(session, "clear");
    }
  }
  /** A reasoning level the new model lacks falls back to the model default. */
  setModel(sessionId: string, modelId: string) {
    const session = this.session(sessionId);
    if (!session.catalog.some((model) => model.id === modelId)) throw new Error("This model is not in the model list");
    session.model = modelId;
    if (!this.efforts(session).includes(session.effort)) session.effort = "default";
    this.host.saveModel?.(modelId);
    return { configOptions: this.options(session) };
  }
  /** Stores the mode in session meta and sends current_mode_update. */
  setMode(sessionId: string, modeId: string) {
    const session = this.session(sessionId);
    if (!MODES.some((mode) => mode.id === modeId)) throw new Error("Unknown agent mode");
    session.meta.mode = modeId as PermissionMode;
    this.host.update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: modeId });
    return {};
  }
  async setConfigOption(sessionId: string, configId: string, value: string) {
    const session = this.session(sessionId);
    if (configId === "model") return this.setModel(sessionId, value);
    if (configId === "mode") {
      this.setMode(sessionId, value);
      return { configOptions: this.options(session) };
    }
    if (configId !== "reasoning" && await this.host.setConfigOption?.(session, configId, value)) return { configOptions: this.options(session) };
    if (configId !== "reasoning") throw new Error("Unknown agent setting");
    if (value !== "default" && !this.efforts(session).includes(value)) throw new Error("This model does not support that reasoning level");
    session.effort = value;
    return { configOptions: this.options(session) };
  }
  cancel(sessionId?: string) {
    for (const session of this.sessions.values())
      if (!sessionId || session.id === sessionId) session.abort?.abort();
  }
  /** Cancels every session and runs SessionEnd hooks. */
  async dispose(reason = "other") {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.abort?.abort();
    await Promise.all(sessions.map((session) => this.end(session, reason)));
  }
  private async end(session: LiveSession, reason: string) {
    await new PromptTurn(this.host, session, new AbortController().signal).hook("SessionEnd", { reason }).catch(() => {});
  }
  async prompt(sessionId: string, blocks: Params[]): Promise<{ stopReason: string }> {
    const session = this.session(sessionId);
    if (session.abort) throw new Error("Wait for the current agent operation or stop it first");
    const abort = new AbortController();
    session.abort = abort;
    const turn = new PromptTurn(this.host, session, abort.signal);
    try {
      const result = await this.turn(session, blocks, turn);
      if (result.stopReason !== "cancelled") this.title(session);
      return result;
    } finally {
      try {
        await this.host.extensions?.sessions?.save(toRecord(session));
      } catch (error) {
        turn.notice(`The session was not saved: ${error instanceof Error ? error.message : String(error)}`);
      }
      session.abort = undefined;
      void this.publishCommands(session);
    }
  }
  private async turn(session: LiveSession, blocks: Params[], turn: PromptTurn) {
    const first = blocks.find((block) => block.type === "text");
    const match = typeof first?.text === "string" ? COMMAND.exec(first.text) : null;
    const command = match ? (await this.commandList(session)).find((item) => item.name === match[1]) : undefined;
    if (command) {
      const result = await command.run((match![2] ?? "").trim(), this.commandContext(session, turn));
      if ("done" in result) return { stopReason: result.done };
      blocks = blocks.map((block) => block === first ? { ...block, text: result.prompt } : block);
    }
    if (!session.model) throw new Error("Choose a model in Agent setup");
    const models = this.service();
    const endpoint = this.host.endpoint();
    let text = promptText(blocks);
    const submit = await turn.hook("UserPromptSubmit", { prompt: text });
    if (turn.halt) return turn.halted();
    if (submit.block) {
      turn.notice(submit.reason || "A hook blocked this prompt");
      return { stopReason: "end_turn" };
    }
    if (submit.additionalContext) text += `\n\n${submit.additionalContext.slice(0, CONTEXT_LIMIT)}`;
    const user: Turn = { role: "user", text };
    session.turns.push(user);
    try {
      return await turn.run(models, endpoint);
    } catch (error) {
      // The controller restores the draft after a failure; drop the turn so a resend does not repeat it.
      if (session.turns.at(-1) === user) session.turns.pop();
      throw error;
    }
  }
  /** Once per session, after its first finished turn: a model-written title in meta and session_info_update. */
  private title(session: LiveSession) {
    if (session.titled || this.host.generateTitles === false || session.meta.title || !titleInput(session.turns)) return;
    session.titled = true;
    void generateTitle(this.host, session, new AbortController().signal).then(async (title) => {
      if (!title || this.sessions.get(session.id) !== session) return;
      session.meta.title = title;
      this.host.update(session.id, { sessionUpdate: "session_info_update", title });
      await this.host.extensions?.sessions?.save(toRecord(session));
    }).catch(() => {});
  }
  private async commandList(session: LiveSession): Promise<AgentCommand[]> {
    const lists = await Promise.all((this.host.extensions?.commands ?? []).map((provider) => provider.commands(session)));
    return [contextCommand(this.host, session), ...lists.flat()];
  }
  private commandContext(session: LiveSession, turn: PromptTurn): CommandContext {
    return {
      session, signal: turn.signal,
      update: (value) => this.host.update(session.id, value),
      request: (method, params) => this.host.request(method, params),
      replaceTurns: (turns) => void (session.turns = turns),
      compact: async () => {
        const endpoint = this.host.endpoint();
        return turn.compact("manual", turn.summarizer(ADAPTERS[endpoint.api], this.service(), endpoint));
      },
    };
  }
  /** Sends available_commands_update when the session's command list differs from the last one sent. */
  private async publishCommands(session: LiveSession) {
    if (this.sessions.get(session.id) !== session) return;
    const commands = await this.commandList(session).catch(() => []);
    if (this.sessions.get(session.id) !== session) return;
    const available = commands.map((command) => ({ name: command.name, description: command.description,
      ...command.hint ? { input: { hint: command.hint } } : {} }));
    const key = JSON.stringify(available);
    if (key === (session.commands ?? "[]")) return;
    session.commands = key;
    try {
      this.host.update(session.id, { sessionUpdate: "available_commands_update", availableCommands: available });
    } catch {
      // Runs from a timer; a closed client connection must not reject it unhandled.
      session.commands = undefined;
    }
  }
}
