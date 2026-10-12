import type { Writable } from "node:stream";
import type { Params, PermissionMode } from "@oxbit/agent-core";
import type { MemoryConnection } from "./connection.js";

export interface PrintOptions {
  connection: MemoryConnection;
  prompt: string;
  /** A saved session to continue. */
  sessionId?: string;
  cwd?: string;
  mode?: PermissionMode;
  /** Switches the session to this model when it differs. */
  model?: string;
  stdout: Writable;
  stderr: Writable;
  /** Aborting cancels the turn, for SIGINT. */
  signal?: AbortSignal;
}

const firstLine = (text: unknown) => String(text ?? "").trim().split("\n")[0].slice(0, 200);

/** One prompt: reply text to stdout, tool lines to stderr. 0 for end_turn, 130 when cancelled, 1 otherwise. Permission prompts are denied. */
export async function runPrint(options: PrintOptions): Promise<number> {
  const { connection, stdout, stderr } = options;
  let last = "\n";
  const write = (text: string) => {
    if (!text) return;
    stdout.write(text);
    last = text.at(-1)!;
  };
  const note = (text: string) => stderr.write(`${text}\n`);
  try {
    const state = options.sessionId ? await connection.loadSession(options.sessionId) : await connection.newSession(options.cwd ? { cwd: options.cwd } : {});
    const { sessionId } = state;
    if (options.mode) await connection.setMode(sessionId, options.mode);
    if (options.model && options.model !== state.models?.currentModelId) await connection.setModel(sessionId, options.model);
    const titles = new Map<string, string>();
    connection.onUpdate((id, update: Params) => {
      if (id !== sessionId) return;
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content?.type === "text") write(update.content.text);
          break;
        case "tool_call":
          titles.set(update.toolCallId, update.title);
          note(`• ${update.title}`);
          break;
        case "tool_call_update":
          if (update.status === "failed") note(`  ✗ ${titles.get(update.toolCallId) ?? update.toolCallId}: ${firstLine(update.rawOutput)}`);
          break;
        case "plan":
          for (const entry of update.entries ?? []) note(`  ${entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "›" : "○"} ${entry.content}`);
          break;
      }
    });
    connection.onPermission(async (request) => {
      note(`  Denied: ${request.toolCall?.title ?? "a tool call"}. Run with --mode accept-edits or --mode full-auto to allow it.`);
      const reject = request.options.find((option) => option.kind === "reject_once");
      return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
    });
    const cancel = () => connection.cancel(sessionId);
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const { stopReason } = await connection.prompt(sessionId, options.prompt);
      if (last !== "\n") write("\n");
      if (stopReason === "end_turn") return 0;
      note(stopReason === "cancelled" ? "Cancelled" : `Stopped: ${stopReason}`);
      return stopReason === "cancelled" ? 130 : 1;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  } catch (error) {
    if (last !== "\n") write("\n");
    note(`oxbit-agent: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
