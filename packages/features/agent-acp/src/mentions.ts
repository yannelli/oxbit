import type { ACPContext, FileSystem, GitCommit } from "@oxbit/sdk";
import { workspaceEntries } from "@oxbit/workbench";
import type { Conversation } from "./history.js";
import { agentName } from "./launch.js";

export type Mention =
  | { kind: "file"; path: string }
  | { kind: "symbol"; name: string; path: string; line: number; endLine: number }
  | { kind: "thread"; id: string; title: string; agent: string; updatedAt: string }
  | { kind: "commit"; id: string; subject: string; author: string; date: string }
  | { kind: "folder"; path: string }
  | { kind: "selection" | "diagnostics" | "changes" | "branch" };

export type SymbolMention = Extract<Mention, { kind: "symbol" }>;
export type ThreadMention = Extract<Mention, { kind: "thread" }>;
export type CommitMention = Extract<Mention, { kind: "commit" }>;

interface Position { line: number }
/** The parts of the language service's `workspaceSymbols` that mentions use. */
export interface WorkspaceSymbolSource {
  workspaceSymbols(query: string, signal?: AbortSignal): Promise<{
    service: { path(uri: string): string };
    target: { uri: string; range: { start: Position; end: Position }; name?: string };
  }[]>;
}

/** The `@query` token that ends at the caret, if any. */
export function mentionQuery(value: string, caret: number) {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  if (!match) return undefined;
  return { start: caret - match[1].length - 1, query: match[1] };
}

export function insertMention(value: string, start: number, caret: number, text: string) {
  const end = /^\S*/.exec(value.slice(caret))![0].length + caret;
  const inserted = `@${text} `;
  const next = value.slice(0, start) + inserted + value.slice(end).replace(/^ /, "");
  return { value: next, caret: start + inserted.length };
}

export function subsequence(path: string, term: string) {
  let at = 0;
  return [...term].every((char) => {
    const found = path.indexOf(char, at);
    at = found + 1;
    return found >= 0;
  });
}

/** Orders basename prefix matches first, then basename substrings, then shorter paths. */
export function rankFiles(paths: string[], query: string, limit = 20) {
  const term = query.toLowerCase();
  const score = (path: string) => {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    return name.startsWith(term) ? 0 : name.includes(term) ? 1 : lower.includes(term) ? 2 : 3;
  };
  return paths
    .filter((path) => subsequence(path.toLowerCase(), term))
    .map((path) => ({ path, score: score(path) }))
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((item) => item.path);
}

/** Uses the host quick-open index when present, else walks the workspace like quick open. */
export async function searchFiles(filesystem: FileSystem, query: string, signal: AbortSignal) {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  if (filesystem.findFiles) return rankFiles(await filesystem.findFiles(term, signal), term);
  const matches: string[] = [];
  for await (const entry of workspaceEntries(filesystem, {
    signal,
    exclude: [".git", "node_modules"],
    skipUnavailable: true,
  })) {
    if (entry.kind === "file" && subsequence(entry.path.toLowerCase(), term)) matches.push(entry.path);
    if (matches.length >= 1000) break;
  }
  return rankFiles(matches, term);
}

/** Symbols from running language servers that support workspace symbols; lines are 1-based. */
export async function searchSymbols(language: WorkspaceSymbolSource | undefined, query: string, signal: AbortSignal, limit = 10) {
  const term = query.trim();
  if (!language || term.length < 2) return [];
  const symbols: SymbolMention[] = [];
  for (const { service, target } of await language.workspaceSymbols(term, signal)) {
    let path: string;
    try {
      path = service.path(target.uri);
    } catch {
      continue;
    }
    const line = target.range.start.line + 1;
    symbols.push({ kind: "symbol", name: target.name || term, path, line, endLine: target.range.end.line + 1 });
    if (symbols.length >= limit) break;
  }
  return symbols;
}

/** Saved conversations whose title contains `query`, newest first. */
export function searchThreads(
  entries: readonly Conversation[],
  query: string,
  { exclude, root }: { exclude?: string; root?: string } = {},
  limit = 5,
): ThreadMention[] {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  return entries
    .filter((entry) => entry.id !== exclude && (!root || entry.root === root) && entry.title.toLowerCase().includes(term))
    .slice(0, limit)
    .map((entry) => ({
      kind: "thread",
      id: entry.id,
      title: entry.title,
      agent: entry.name || agentName(entry.provider),
      updatedAt: entry.updatedAt,
    }));
}

/** The conversation's user and agent messages, keeping the latest `limit` characters. */
export function threadTranscript(entry: Pick<Conversation, "activity" | "name" | "provider" | "title">, limit = 200000) {
  const messages = entry.activity.flatMap((item) =>
    item.kind === "message" && item.message.role !== "thought" && item.message.text.trim()
      ? [`${item.message.role === "user" ? "User" : "Agent"}: ${item.message.text.trim()}`]
      : []);
  if (!messages.length) return "";
  const head = `Earlier conversation with ${entry.name || agentName(entry.provider)}: ${entry.title}\n\n`;
  const body = messages.join("\n\n");
  return head + (head.length + body.length > limit ? body.slice(head.length + body.length - limit) : body);
}

/** The thread context for a conversation forked at activity `index`: the messages before it. */
export function forkContext(entry: Pick<Conversation, "activity" | "name" | "provider" | "title">, index: number): ACPContext | undefined {
  const text = threadTranscript({ ...entry, activity: entry.activity.slice(0, index) });
  return text ? { path: ".", text, kind: "thread", label: `Thread: ${entry.title}` } : undefined;
}

/** Commits whose subject or author contains `query`, or whose hash starts with it, in log order. */
export function searchCommits(commits: readonly GitCommit[], query: string, limit = 5): CommitMention[] {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  return commits
    .filter((commit) => commit.id.startsWith(term) || commit.subject.toLowerCase().includes(term) || commit.author.toLowerCase().includes(term))
    .slice(0, limit)
    .map(({ id, subject, author, date }) => ({ kind: "commit", id, subject, author, date }));
}

/** Folders above the matched file paths whose path matches `query`, ranked like files. */
export function searchFolders(paths: readonly string[], query: string, limit = 5) {
  const folders = new Set<string>();
  for (const path of paths)
    for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) folders.add(path.slice(0, at));
  return rankFiles([...folders], query.trim(), limit);
}
