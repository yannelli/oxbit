import type { Params } from "@oxbit/agent-core";
import { stableLength } from "./markdown-parse.js";
import type { SessionUpdate } from "./connection.js";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export interface DiffBlock { path: string; oldText: string | null; newText: string }
export interface ToolView {
  toolCallId: string;
  title: string;
  kind: string;
  status: ToolStatus;
  rawInput?: unknown;
  output?: string;
  diffs: DiffBlock[];
  terminal?: boolean;
}
export interface PlanEntry { content: string; status: string; priority?: string }
export type Item =
  | { id: number; type: "banner" }
  | { id: number; type: "user"; text: string; continuation?: boolean }
  | { id: number; type: "assistant"; text: string; part?: boolean; done?: boolean }
  | { id: number; type: "thought"; text: string; done?: boolean }
  | { id: number; type: "tool"; tool: ToolView; done?: boolean }
  | { id: number; type: "plan"; entries: PlanEntry[]; done?: boolean }
  | { id: number; type: "notice"; text: string; tone: "info" | "warn" | "error" }
  | { id: number; type: "divider"; text: string };
type NewItem = Item extends infer T ? T extends Item ? Omit<T, "id"> : never : never;

/** `flushed` only grows and feeds Ink's <Static>; `live` holds items that can still change. */
export interface Transcript { flushed: Item[]; live: Item[]; next: number }

export const emptyTranscript = (): Transcript => ({ flushed: [{ id: 0, type: "banner" }], live: [], next: 1 });

const STREAMING = new Set(["assistant", "thought", "plan"]);
const FINAL = new Set(["banner", "user", "notice", "divider"]);
const isDone = (item: Item) => FINAL.has(item.type) || !!(item as { done?: boolean }).done;
const textOf = (content: unknown) => {
  const block = content as Params | undefined;
  if (block?.type === "text" && typeof block.text === "string") return block.text;
  return block?.type === "image" ? "[image]" : block?.type === "resource_link" ? `[${block.name ?? block.uri}]` : "";
};
const outputOf = (value: unknown) => value === undefined || value === null ? undefined : typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** Moves finished leading items to `flushed`, and the finished blocks of a streaming head message with them. */
export function flush(state: Transcript): Transcript {
  let { flushed, live, next } = state;
  let count = 0;
  while (count < live.length && isDone(live[count])) count++;
  if (count) {
    flushed = [...flushed, ...live.slice(0, count)];
    live = live.slice(count);
  }
  const head = live[0];
  if (head?.type === "assistant" && !head.done) {
    const cut = stableLength(head.text);
    if (cut > 0 && head.text.slice(cut).trim()) {
      flushed = [...flushed, { ...head, text: head.text.slice(0, cut), done: true }];
      live = [{ ...head, id: next++, text: head.text.slice(cut), part: true }, ...live.slice(1)];
    }
  }
  return flushed === state.flushed && live === state.live ? state : { flushed, live, next };
}

/** Appends an item and closes the streaming items before it. */
export function append(state: Transcript, item: NewItem): Transcript {
  const live = state.live.map((entry) => STREAMING.has(entry.type) && !isDone(entry) ? { ...entry, done: true } as Item : entry);
  return flush({ ...state, live: [...live, { ...item, id: state.next } as Item], next: state.next + 1 });
}

const replace = (state: Transcript, index: number, item: Item) =>
  flush({ ...state, live: state.live.map((entry, at) => at === index ? item : entry) });

function stream(state: Transcript, type: "assistant" | "thought", text: string): Transcript {
  if (!text) return state;
  const index = state.live.length - 1;
  const last = state.live[index];
  if (last?.type === type && !last.done) return replace(state, index, { ...last, text: last.text + text });
  return append(state, { type, text: type === "assistant" ? text.replace(/^\n+/, "") : text });
}

function tool(state: Transcript, update: Params): Transcript {
  const index = state.live.findIndex((item) => item.type === "tool" && item.tool.toolCallId === update.toolCallId);
  const current = index >= 0 ? (state.live[index] as Extract<Item, { type: "tool" }>).tool : undefined;
  const content = Array.isArray(update.content) ? update.content as Params[] : undefined;
  const diffs = content?.filter((block) => block.type === "diff").map((block) => ({ path: String(block.path ?? ""), oldText: block.oldText ?? null, newText: String(block.newText ?? "") }));
  const text = content?.filter((block) => block.type === "content").map((block) => textOf(block.content)).join("\n");
  const next: ToolView = {
    toolCallId: String(update.toolCallId ?? ""),
    title: typeof update.title === "string" ? update.title : current?.title ?? "Tool",
    kind: typeof update.kind === "string" ? update.kind : current?.kind ?? "other",
    status: typeof update.status === "string" ? update.status as ToolStatus : current?.status ?? "pending",
    rawInput: "rawInput" in update ? update.rawInput : current?.rawInput,
    output: outputOf(update.rawOutput) ?? (text || current?.output),
    diffs: diffs?.length ? diffs : current?.diffs ?? [],
    terminal: current?.terminal || !!content?.some((block) => block.type === "terminal"),
  };
  const done = next.status === "completed" || next.status === "failed";
  if (index < 0 && state.flushed.slice(-50).some((item) => item.type === "tool" && item.tool.toolCallId === next.toolCallId)) return state;
  if (index < 0) return append(state, { type: "tool", tool: next, done });
  return replace(state, index, { id: state.live[index].id, type: "tool", tool: next, done });
}

/** Applies one ACP session/update to the transcript. Status fields (title, usage, mode) live in the controller. */
export function applyUpdate(state: Transcript, update: SessionUpdate): Transcript {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": return stream(state, "assistant", textOf(update.content));
    case "agent_thought_chunk": return stream(state, "thought", textOf(update.content));
    case "user_message_chunk": {
      const text = textOf(update.content);
      return text ? append(state, { type: "user", text, continuation: !!update._meta?.oxbit?.continuation }) : state;
    }
    case "tool_call":
    case "tool_call_update": return tool(state, update);
    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries as PlanEntry[] : [];
      const index = state.live.length - 1;
      const last = state.live[index];
      if (last?.type === "plan" && !last.done) return replace(state, index, { ...last, entries });
      return append(state, { type: "plan", entries });
    }
  }
  return state;
}

/** Ends a prompt turn: every live item is final, and tool calls that never finished show as cancelled. */
export function endTurn(state: Transcript): Transcript {
  const live = state.live.map((item): Item => item.type === "tool" && !item.done
    ? { ...item, done: true, tool: { ...item.tool, status: item.tool.status === "failed" ? "failed" : "cancelled" } }
    : FINAL.has(item.type) ? item : { ...item, done: true } as Item);
  return flush({ ...state, live });
}
