import type { PermissionOption, PermissionOutcome, PermissionRequest } from "./connection.js";

export type Decision = "once" | "session" | "deny";
export const DECISIONS: Decision[] = ["once", "session", "deny"];

const option = (options: PermissionOption[], kinds: string[], ids: string[]) =>
  options.find((item) => kinds.includes(item.kind)) ?? options.find((item) => ids.includes(item.optionId));
const selected = (optionId: string): PermissionOutcome => ({ outcome: { outcome: "selected", optionId } });
const cancelled: PermissionOutcome = { outcome: { outcome: "cancelled" } };

export function commandOf(request: PermissionRequest) {
  const input = request.toolCall.rawInput as { command?: unknown } | undefined;
  return typeof input?.command === "string" ? input.command : request.toolCall.title ?? "";
}

/** Session rules match shell commands by program name and other tools by kind. */
export function ruleKey(request: PermissionRequest) {
  const kind = request.toolCall.kind ?? "other";
  if (kind !== "execute") return kind;
  return `execute:${commandOf(request).trim().split(/\s+/)[0] ?? ""}`;
}

export function decisionLabel(request: PermissionRequest, decision: Decision) {
  if (decision === "once") return "Yes";
  if (decision === "deny") return "No, tell the agent what to do instead";
  const kind = request.toolCall.kind ?? "other";
  if (kind === "execute") return `Yes, and allow \`${ruleKey(request).slice(8) || "these"}\` commands for this session`;
  if (kind === "edit") return "Yes, and allow edits for this session";
  return `Yes, and allow ${kind} tools for this session`;
}

export function question(request: PermissionRequest) {
  const kind = request.toolCall.kind ?? "other";
  if (kind === "execute") return "Run this command?";
  if (kind === "edit") return "Apply this edit?";
  if (kind === "delete") return "Delete this?";
  return `Allow ${request.toolCall.title ?? "this tool call"}?`;
}

/** "session" uses the agent's allow_always option when offered, else allow_once with `remember` set for a TUI-side rule. */
export function outcomeOf(request: PermissionRequest, decision: Decision): { outcome: PermissionOutcome; remember: boolean } {
  const once = option(request.options, ["allow_once"], ["allow"]);
  const always = option(request.options, ["allow_always"], []);
  const reject = option(request.options, ["reject_once", "reject_always"], ["reject", "deny"]);
  if (decision === "deny") return { outcome: reject ? selected(reject.optionId) : cancelled, remember: false };
  if (decision === "session" && always) return { outcome: selected(always.optionId), remember: false };
  const allow = once ?? always;
  return { outcome: allow ? selected(allow.optionId) : cancelled, remember: decision === "session" };
}

export const cancelOutcome = () => cancelled;
