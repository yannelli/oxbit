import type { AgentCommand, CommandContext, CommandProvider, Compactor, SessionView } from "./extensions.js";
import type { ToolResult, Turn } from "./model.js";

type Summarize = (system: string, turns: Turn[]) => Promise<string>;
export interface CompactionOptions {
  /** false turns off automatic compaction; /compact still works. Defaults to true. */
  auto?: boolean;
  /** Tokens kept free for the next response, at most the model's output limit. Defaults to 20000. */
  reserve?: number;
  /** Newest tokens kept verbatim after a summary. Defaults to 20000. */
  keepTokens?: number;
}

/** session.meta key that carries the `/compact` focus text while the compactor runs. */
export const COMPACT_FOCUS = "compactFocus";
export const CLEARED_OUTPUT = "[Old tool result content cleared]";
const PRUNE_PROTECT = 40000;
const PRUNE_MINIMUM = 20000;
const PROTECTED_TOOLS = new Set(["skill"]);
const DEFAULT_MAX_OUTPUT = 32000;
const SUMMARY_SYSTEM = "You are a context summarization assistant. You read a coding agent's conversation and write a summary that "
  + "another model uses to continue the work. Answer with the summary text only. Do not call tools.";
const SUMMARY_REQUEST = `Summarize the conversation above as a checkpoint for continuing the work. If it starts with an earlier summary, merge that summary in.
Use these sections:
## Goal
## Decisions
## Files touched
Paths that were read and paths that were changed, with what changed.
## Open work
Unfinished tasks and next steps, including the step in progress.
## User preferences
Constraints and preferences the user stated.
Keep exact file paths, commands, identifiers and error messages.`;

const chars = (turn: Turn) => turn.role === "user" ? turn.text.length
  : turn.role === "assistant" ? turn.text.length + turn.calls.reduce((sum, call) => sum + call.name.length + call.arguments.length, 0)
    : turn.results.reduce((sum, result) => sum + result.output.length, 0);
/** Estimate at 4 characters per token. */
export const estimateTokens = (turns: readonly Turn[]) => Math.ceil(turns.reduce((sum, turn) => sum + chars(turn), 0) / 4);
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}\n[${text.length - max} more characters]` : text;

/** Clears tool outputs beyond the newest 40,000 tokens of output, outside the last two user turns. No-op when it saves under 20,000 tokens. */
export function pruneToolOutputs(turns: readonly Turn[]): { turns: Turn[]; saved: number } {
  let users = 0;
  let start = 0;
  for (let index = turns.length - 1; index >= 0; index--)
    if (turns[index].role === "user" && ++users === 2) {
      start = index;
      break;
    }
  const cleared = new Set<ToolResult>();
  let kept = 0;
  let saved = 0;
  for (let index = users < 2 ? -1 : start - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn.role !== "tool") continue;
    for (const result of [...turn.results].reverse()) {
      if (PROTECTED_TOOLS.has(result.name) || result.output === CLEARED_OUTPUT) continue;
      const tokens = Math.ceil(result.output.length / 4);
      kept += tokens;
      if (kept <= PRUNE_PROTECT) continue;
      cleared.add(result);
      saved += tokens;
    }
  }
  if (saved < PRUNE_MINIMUM) return { turns: [...turns], saved: 0 };
  return { saved, turns: turns.map((turn) => turn.role === "tool" && turn.results.some((result) => cleared.has(result))
    ? { role: "tool", results: turn.results.map((result) => cleared.has(result) ? { ...result, output: CLEARED_OUTPUT } : result) } : turn) };
}

/** Index of the oldest turn that starts a suffix within `budget` tokens. A suffix never starts with tool results. */
export function keepFrom(turns: readonly Turn[], budget: number) {
  let tokens = 0;
  let cut = turns.length;
  for (let index = turns.length - 1; index >= 0; index--) {
    tokens += Math.ceil(chars(turns[index]) / 4);
    if (tokens > budget) break;
    if (turns[index].role !== "tool") cut = index;
  }
  return cut;
}

function transcript(turns: readonly Turn[], maxChars?: number) {
  const text = turns.map((turn) => turn.role === "user" ? `[User]\n${turn.text}`
    : turn.role === "assistant" ? [turn.text && `[Assistant]\n${turn.text}`, ...turn.calls.map((call) => `[Tool call ${call.name}]\n${clip(call.arguments, 1000)}`)]
      .filter((part) => !!part).join("\n\n")
      : turn.results.map((result) => `[Tool result ${result.name}${result.error ? ", failed" : ""}]\n${clip(result.output, 2000)}`).join("\n\n"),
  ).join("\n\n");
  return maxChars && text.length > maxChars ? `[Earlier messages omitted]\n${text.slice(-maxChars)}` : text;
}
export const summaryNote = (summary: string) => `The conversation before this point was compacted into this summary:\n\n<summary>\n${summary}\n</summary>`;

/** Compactor and `/compact [focus]` command. Auto compaction prunes old tool outputs first and summarizes only when that is not enough. */
export class Compaction implements Compactor, CommandProvider {
  /** Set when shouldCompact returns true; its absence in compact() means a manual run. */
  private pending = new Map<string, { used: number; threshold: number }>();
  private usable = new Map<string, number>();
  constructor(private options: CompactionOptions = {}) {}
  /** Tokens a request can use before compaction: the window minus min(reserve, maxOutput or 32000, window / 4). */
  threshold(contextWindow: number, maxOutput?: number) {
    return contextWindow - Math.min(this.options.reserve ?? 20000, maxOutput ?? DEFAULT_MAX_OUTPUT, Math.floor(contextWindow / 4));
  }
  autoThreshold(contextWindow: number, maxOutput?: number) {
    return this.options.auto === false ? undefined : this.threshold(contextWindow, maxOutput);
  }
  /** Due when the last request's input plus output reaches the threshold. turn.ts does not pass `maxOutput` yet. */
  shouldCompact(session: SessionView, usage: { input: number; output: number }, contextWindow?: number, maxOutput?: number) {
    if (!contextWindow) return false;
    const threshold = this.threshold(contextWindow, maxOutput);
    this.usable.set(session.id, threshold);
    const used = usage.input + usage.output;
    const due = this.options.auto !== false && used >= threshold;
    if (due) this.pending.set(session.id, { used, threshold });
    else this.pending.delete(session.id);
    return due;
  }
  /** Returns [summary note, newest turns within keepTokens]. When every turn fits, the summary covers them all and none are kept. */
  async compact(session: SessionView, summarize: Summarize, signal: AbortSignal): Promise<Turn[]> {
    const pending = this.pending.get(session.id);
    this.pending.delete(session.id);
    const { turns, saved } = pruneToolOutputs(session.turns);
    if (pending && saved && pending.used - saved < pending.threshold) return turns;
    if (!turns.length) return turns;
    const usable = this.usable.get(session.id);
    const cut = keepFrom(turns, Math.min(this.options.keepTokens ?? 20000, usable ? Math.floor(usable / 2) : Infinity));
    const head = cut === 0 ? turns : turns.slice(0, cut);
    const focus = typeof session.meta[COMPACT_FOCUS] === "string" ? (session.meta[COMPACT_FOCUS] as string).trim() : "";
    const request = `<conversation>\n${transcript(head, usable ? usable * 3 : undefined)}\n</conversation>\n\n${SUMMARY_REQUEST}`
      + (focus ? `\n\nAdditional focus: ${focus}` : "");
    const summary = (await summarize(SUMMARY_SYSTEM, [{ role: "user", text: request }])).trim();
    if (signal.aborted) throw new Error("Cancelled");
    if (!summary) throw new Error("The model returned an empty summary, so the conversation was not compacted");
    return [{ role: "user", text: summaryNote(summary) }, ...cut === 0 ? [] : turns.slice(cut)];
  }
  commands(): AgentCommand[] {
    return [{ name: "compact", description: "Summarize the conversation to free context", hint: "focus for the summary (optional)",
      run: (args, context) => this.run(args, context) }];
  }
  private async run(args: string, context: CommandContext) {
    const { session } = context;
    const notice = (text: string) => context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    const before = session.turns.length;
    if (!before) {
      notice("There is nothing to compact.");
      return { done: "end_turn" };
    }
    this.pending.delete(session.id);
    if (args) session.meta[COMPACT_FOCUS] = args;
    try {
      const ran = await context.compact();
      notice(ran ? `Compacted ${before} turns into a summary and ${session.turns.length - 1} recent turns.`
        : "Compaction did not run: a PreCompact hook blocked it or no compactor is set.");
      return { done: "end_turn" };
    } catch (error) {
      if (context.signal.aborted) return { done: "cancelled" };
      throw error;
    } finally {
      delete session.meta[COMPACT_FOCUS];
    }
  }
}
