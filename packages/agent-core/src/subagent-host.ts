import type { AgentExtensions, HookEvent, HookRunner, Params, SessionView } from "./extensions.js";
import type { AgentHost } from "./host.js";
import type { LiveSession } from "./turn.js";

const FORWARDED_HOOKS = new Set<HookEvent>(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact"]);

export interface ChildLink {
  parent: LiveSession;
  childId: string;
  /** The parent's task tool call. */
  spawnId: string;
  /** The client accepts child sessions; otherwise child tool calls are forwarded on the parent session. */
  native: boolean;
  signal: AbortSignal;
}

export const childCallId = (spawnId: string, id: string) => `${spawnId}/${id}`;

/** Parent providers see the parent's id, so MCP connections are shared, and fresh meta, so goal and loop tools stay out. */
function childExtensions(host: AgentHost, { parent, childId }: ChildLink): AgentExtensions {
  const source = host.extensions;
  if (!source) return {};
  const view = (): SessionView => ({ id: parent.id, cwd: parent.cwd, model: parent.model, turns: [], meta: { mcpServers: parent.meta.mcpServers } });
  const runner = source.hooks;
  const hooks: HookRunner | undefined = runner && {
    run: async (event, input, signal) => FORWARDED_HOOKS.has(event) ? runner.run(event, { ...input, session_id: parent.id, agent_id: childId }, signal) : {},
  };
  return {
    tools: source.tools?.map((provider) => ({ tools: () => provider.tools(view()) })),
    context: source.context?.map((provider) => ({ label: provider.label, system: () => provider.system(view()) })),
    ...hooks ? { hooks } : {},
    ...source.compactor ? { compactor: source.compactor } : {},
  };
}

function childUpdate(host: AgentHost, { parent, spawnId, native }: ChildLink): AgentHost["update"] {
  if (native) return (sessionId, update) => host.update(sessionId, update);
  return (_sessionId, update) => {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    host.update(parent.id, { ...update, toolCallId: childCallId(spawnId, String(update.toolCallId)),
      _meta: { ...update._meta, oxbit: { ...update._meta?.oxbit, subagentOf: spawnId } } });
  };
}

const forwarded = (params: Params, { parent, spawnId }: ChildLink): Params => ({
  ...params,
  ..."sessionId" in params ? { sessionId: parent.id } : {},
  ...typeof params.toolCallId === "string" ? { toolCallId: childCallId(spawnId, params.toolCallId) } : {},
  ...typeof params.toolCall?.toolCallId === "string" ? { toolCall: { ...params.toolCall, toolCallId: childCallId(spawnId, params.toolCall.toolCallId) } } : {},
});

/** Client requests settle when the child is cancelled, so an unanswered permission prompt does not hold the parent turn. */
function childRequest(host: AgentHost, link: ChildLink): AgentHost["request"] {
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("Cancelled by the user"));
    if (link.signal.aborted) fail();
    else link.signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => {});
  return (method, params) => {
    const raw = host.request(method, link.native ? params : forwarded(params, link));
    raw.catch(() => {});
    return Promise.race([raw, aborted]);
  };
}

/** The parent host with child routing, no subagents, titles, commands, continuations, sessions or snapshots. */
export const childHost = (host: AgentHost, link: ChildLink): AgentHost => ({
  ...host, subagents: undefined, generateTitles: false,
  update: childUpdate(host, link), request: childRequest(host, link), extensions: childExtensions(host, link),
});
