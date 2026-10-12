import type { Draft } from "./editor.js";

export interface Command { name: string; description: string; hint?: string }
export interface CompletionItem { value: string; label: string; detail?: string }
export interface Completion { kind: "command" | "file"; items: CompletionItem[]; index: number; start: number; end: number; query: string }
interface Token { query: string; start: number; end: number }

/** The `/name` token when the cursor is inside it. */
export function commandToken({ text, cursor }: Draft): Token | undefined {
  if (!text.startsWith("/")) return undefined;
  const space = text.search(/\s/);
  const end = space < 0 ? text.length : space;
  return cursor <= end ? { query: text.slice(1, end), start: 0, end } : undefined;
}

/** The `@path` token that ends at the cursor. */
export function fileToken({ text, cursor }: Draft): Token | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  if (!match) return undefined;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { query: match[1], start: cursor - match[1].length - 1, end };
}

/** Prefix beats substring beats subsequence; undefined when `query` is not a subsequence. */
export function score(candidate: string, query: string) {
  if (!query) return 0;
  const text = candidate.toLowerCase();
  const wanted = query.toLowerCase();
  if (text.startsWith(wanted)) return 3000 - text.length;
  const at = text.indexOf(wanted);
  if (at >= 0) return 2000 - at;
  let position = -1;
  let gaps = 0;
  for (const char of wanted) {
    const next = text.indexOf(char, position + 1);
    if (next < 0) return undefined;
    gaps += next - position - 1;
    position = next;
  }
  return 1000 - gaps;
}

export function rank<T>(items: readonly T[], key: (item: T) => string, query: string, limit = 50) {
  return items.map((item) => ({ item, score: score(key(item), query) }))
    .filter((entry): entry is { item: T; score: number } => entry.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function commandItems(commands: readonly Command[], query: string): CompletionItem[] {
  return rank(commands, (command) => command.name, query).map((command) => ({
    value: `/${command.name}`, label: `/${command.name}${command.hint ? ` ${command.hint}` : ""}`, detail: command.description }));
}

export function fileItems(paths: readonly string[], query: string): CompletionItem[] {
  const base = (path: string) => path.replace(/\/$/, "").split("/").pop() ?? path;
  const scored = rank(paths, (path) => query.includes("/") ? path : base(path), query, 50);
  const extra = query.includes("/") ? [] : rank(paths.filter((path) => !scored.includes(path)), (path) => path, query, 50 - scored.length);
  return [...scored, ...extra].map((path) => ({ value: `@${path}`, label: path }));
}

/** Replaces the completed token with the item; commands and files get a trailing space unless the path is a directory. */
export function accept(draft: Draft, completion: Completion, item: CompletionItem): Draft {
  const value = item.value.endsWith("/") ? item.value : `${item.value} `;
  const rest = draft.text.slice(completion.end).replace(/^ /, "");
  return { text: draft.text.slice(0, completion.start) + value + rest, cursor: completion.start + value.length };
}
