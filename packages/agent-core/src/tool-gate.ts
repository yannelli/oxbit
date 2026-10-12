import type { HookEvent, HookOutcome, Params, PermissionMode } from "./extensions.js";
import type { ToolGate } from "./tools.js";

export interface GateOptions {
  sessionId: string;
  hook(event: HookEvent, input: Params): Promise<HookOutcome>;
  request(method: string, params: Params): Promise<any>;
  mode(): PermissionMode;
  /** Called before each mutating tool runs. */
  snapshot(label: string): Promise<void>;
}

const CONTEXT_LIMIT = 10000;
const PERMISSION_OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

/** PreToolUse, permission, snapshot and PostToolUse handling around each tool call. Execute tools ask unless the mode is full-auto. */
export function hookGate({ sessionId, hook, request, mode, snapshot }: GateOptions): ToolGate {
  const pending = new Map<string, string>();
  return {
    async before(tool, args, toolCallId) {
      const outcome = await hook("PreToolUse", { tool_name: tool.spec.name, tool_input: args, tool_use_id: toolCallId });
      if (outcome.continue === false) throw new Error(outcome.stopReason || "A hook stopped the agent");
      if (outcome.permission === "deny" || (outcome.block && outcome.permission !== "allow"))
        throw new Error(outcome.permissionReason || outcome.reason || "A hook denied this tool call");
      const next = outcome.updatedInput ?? args;
      const asks = outcome.permission === "ask" || (outcome.permission !== "allow" && tool.kind === "execute" && mode() !== "full-auto");
      if (asks) {
        const response = await request("session/request_permission", { sessionId, options: PERMISSION_OPTIONS,
          toolCall: { toolCallId, title: tool.title(next).slice(0, 200), kind: tool.kind, status: "pending", rawInput: next } });
        if (response?.outcome?.outcome !== "selected" || response.outcome.optionId !== "allow")
          throw new Error(outcome.permissionReason ? `The user denied this tool call: ${outcome.permissionReason}` : "The user denied this tool call");
      }
      if (outcome.additionalContext) pending.set(toolCallId, outcome.additionalContext.slice(0, CONTEXT_LIMIT));
      if (tool.mutates) await snapshot(tool.title(next));
      return next;
    },
    async after(tool, args, toolCallId, output, failed) {
      const before = pending.get(toolCallId);
      pending.delete(toolCallId);
      const outcome = await hook(failed ? "PostToolUseFailure" : "PostToolUse", { tool_name: tool.spec.name, tool_input: args,
        tool_use_id: toolCallId, ...(failed ? { error: output } : { tool_response: output }) });
      const notes = [before, outcome.block ? outcome.reason : undefined, outcome.additionalContext?.slice(0, CONTEXT_LIMIT)];
      return notes.filter((note) => !!note).join("\n\n") || undefined;
    },
  };
}
