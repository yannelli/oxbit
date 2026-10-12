import type { AgentTool, Params, PermissionMode, SessionRecord, SessionView } from "./extensions.js";
import type { Turn } from "./model.js";

export const MODES: { id: PermissionMode; name: string; description: string }[] = [
  { id: "ask", name: "Ask", description: "Review file changes and approve shell commands" },
  { id: "accept-edits", name: "Accept edits", description: "Apply file changes without review and approve shell commands" },
  { id: "full-auto", name: "Full auto", description: "Run tools without asking unless a hook asks" },
];
export const modeOf = (meta: Record<string, unknown>): PermissionMode =>
  MODES.find((mode) => mode.id === meta.mode)?.id ?? "ask";

/** `meta.title` from title generation or a command, else the first line of the first user turn. */
export function sessionTitle(turns: readonly Turn[], meta: Record<string, unknown>) {
  if (typeof meta.title === "string" && meta.title.trim()) return meta.title.trim().slice(0, 200);
  const first = turns.find((turn) => turn.role === "user");
  return first?.role === "user" ? first.text.trim().split("\n")[0].slice(0, 80) : "";
}

export const toRecord = (session: SessionView): SessionRecord => ({
  id: session.id, cwd: session.cwd, title: sessionTitle(session.turns, session.meta), model: session.model,
  turns: [...session.turns], meta: session.meta, updatedAt: new Date().toISOString(),
});

/** Sends a saved conversation as ACP session/update notifications for session/load. */
export function replay(turns: readonly Turn[], tools: readonly AgentTool[], update: (update: Params) => void) {
  const text = (value: string) => ({ type: "text", text: value });
  for (const turn of turns) {
    if (turn.role === "user") update({ sessionUpdate: "user_message_chunk", content: text(turn.text) });
    else if (turn.role === "assistant") {
      if (turn.text) update({ sessionUpdate: "agent_message_chunk", content: text(turn.text) });
      for (const call of turn.calls) {
        let rawInput: unknown;
        try {
          rawInput = JSON.parse(call.arguments || "{}");
        } catch {
          rawInput = call.arguments;
        }
        const tool = tools.find((item) => item.spec.name === call.name);
        const args = rawInput && typeof rawInput === "object" ? rawInput as Params : {};
        update({ sessionUpdate: "tool_call", toolCallId: call.id, title: (tool?.title(args) ?? call.name).slice(0, 200), kind: tool?.kind ?? "other",
          status: "in_progress", rawInput });
      }
    } else
      for (const result of turn.results)
        update({ sessionUpdate: "tool_call_update", toolCallId: result.id, status: result.error ? "failed" : "completed",
          rawOutput: result.output.slice(0, 8000) });
  }
}
