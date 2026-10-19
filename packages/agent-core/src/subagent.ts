import { OXBIT_SUBAGENT_TOOL, type OxbitSubagentMeta } from "@oxbit/sdk";
import type { AgentTool, Params } from "./extensions.js";
import type { AgentHost } from "./host.js";
import { childHost } from "./subagent-host.js";
import type { LiveSession } from "./turn.js";

export interface SubagentOptions {
  host: AgentHost;
  parent: LiveSession;
  /** Runs the child's model and tool loop. */
  runChild(host: AgentHost, child: LiveSession, signal: AbortSignal): Promise<{ stopReason: string }>;
}
type SubagentState = NonNullable<OxbitSubagentMeta["state"]>;

const RESULT_LIMIT = 40000;
const PROMPT_LIMIT = 100000;
const TASK_META_LIMIT = 4096;
const CANCELLED = "Cancelled by the user";
export const SUBAGENT_PROMPT = [
  "You are a subagent. Another agent delegated the task in the user message to you.",
  "You cannot see that agent's conversation and cannot ask the user questions. Work until the task is done or you are blocked.",
  "End with a self-contained report: what you found or changed, with workspace-relative paths, and what is left open. The other agent sees only that report.",
].join("\n");
const DESCRIPTION = `Delegate a self-contained task to a subagent. It starts with a fresh context and the same tools except ${OXBIT_SUBAGENT_TOOL}, `
  + "works until done, and returns its final message as this tool's result. The call blocks until the subagent finishes. "
  + "The user can open that message from the thread, but your reply should still state what matters from it. Use it for broad searches, multi-file investigations or independent changes, "
  + `to keep this conversation's context small. Several ${OXBIT_SUBAGENT_TOOL} calls in one response run in parallel. `
  + "Its file edits and commands go through the same user review as yours.";

const field = (args: Params, key: string) => typeof args[key] === "string" ? args[key] as string : "";

/** The child's last assistant text, with the stop reason when it did not end normally. */
function report(child: LiveSession, stopReason: string) {
  const last = [...child.turns].reverse().find((turn) => turn.role === "assistant");
  let output = (last?.role === "assistant" ? last.text.trim() : "") || "The subagent finished without a final message.";
  if (stopReason !== "end_turn") output += `\n\n[The subagent stopped: ${stopReason}]`;
  return output.length > RESULT_LIMIT ? `${output.slice(0, RESULT_LIMIT)}\n[Truncated at ${RESULT_LIMIT} characters.]` : output;
}

/** The blocking task tool: runs a subagent with a fresh context and returns its final message. */
export function taskTool({ host, parent, runChild }: SubagentOptions): AgentTool {
  const meta = (args: Params, state: SubagentState, sessionId?: string): Params => {
    const subagent: OxbitSubagentMeta = { name: field(args, "description").trim().slice(0, 200), task: field(args, "prompt").slice(0, TASK_META_LIMIT),
      model: parent.model, ...sessionId ? { sessionId } : {}, state };
    return { oxbit: { subagent } };
  };
  return {
    spec: { name: OXBIT_SUBAGENT_TOOL, description: DESCRIPTION, parameters: { type: "object", additionalProperties: false, required: ["description", "prompt"],
      properties: {
        description: { type: "string", maxLength: 200, description: "The task in 3 to 8 words" },
        prompt: { type: "string", minLength: 1, maxLength: PROMPT_LIMIT,
          description: "The full task: the goal, relevant paths and facts from this conversation, constraints, and what to report back" },
      } } },
    kind: "other",
    mutates: true,
    parallel: true,
    title: (args) => `Task: ${field(args, "description").trim() || "subagent"}`,
    meta: (args) => meta(args, "pending"),
    async run(args, context) {
      const description = field(args, "description").trim();
      const prompt = field(args, "prompt");
      if (!description || description.length > 200) throw new Error("description must be a non-empty string of at most 200 characters");
      if (!prompt.trim() || prompt.length > PROMPT_LIMIT) throw new Error(`prompt must be 1 to ${PROMPT_LIMIT} characters`);
      if (context.signal.aborted) throw new Error(CANCELLED);
      const childId = crypto.randomUUID();
      const native = !!host.capabilities.childSessions;
      const sessionId = native ? childId : undefined;
      const abort = new AbortController();
      const child: LiveSession = { id: childId, cwd: parent.cwd, model: parent.model, effort: parent.effort, catalog: parent.catalog,
        turns: [{ role: "user", text: prompt }], context: [SUBAGENT_PROMPT],
        meta: { subagent: { parentSessionId: parent.id, toolCallId: context.toolCallId }, get mode() { return parent.meta.mode; } } };
      let state: SubagentState | undefined;
      const finish = (next: SubagentState) => {
        if (state) return;
        state = next;
        if (native) host.update(parent.id, { sessionUpdate: "subagent_state_update", subagentSessionId: childId, state: next });
        context.update({ sessionUpdate: "tool_call_update", toolCallId: context.toolCallId, _meta: meta(args, next, sessionId) });
      };
      const cancel = () => {
        abort.abort();
        finish("cancelled");
      };
      context.signal.addEventListener("abort", cancel, { once: true });
      try {
        if (native) {
          host.update(parent.id, { sessionUpdate: "subagent_spawned", subagentSessionId: childId, name: description, task: prompt });
          host.update(childId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: prompt } });
        }
        context.update({ sessionUpdate: "tool_call_update", toolCallId: context.toolCallId, _meta: meta(args, "running", sessionId) });
        const link = { parent, childId, spawnId: context.toolCallId, native, signal: abort.signal };
        const { stopReason } = await runChild(childHost(host, link), child, abort.signal);
        if (abort.signal.aborted) throw new Error(CANCELLED);
        finish("completed");
        return report(child, stopReason);
      } catch (error) {
        if (abort.signal.aborted) {
          finish("cancelled");
          throw new Error(CANCELLED);
        }
        finish("failed");
        throw error;
      } finally {
        context.signal.removeEventListener("abort", cancel);
      }
    },
  };
}
