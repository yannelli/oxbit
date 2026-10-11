import type { FileSystem } from "@oxbit/sdk";
import { workspaceEntries } from "@oxbit/workbench";

export type Mention =
  | { kind: "file"; path: string }
  | { kind: "symbol"; name: string; path: string; line: number; endLine: number }
  | { kind: "selection" | "diagnostics" | "changes" };

export type SymbolMention = Extract<Mention, { kind: "symbol" }>;

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
  if (filesystem.findFiles) {
    try { return rankFiles(await filesystem.findFiles(term, signal), term); }
    catch (error) { if ((error as { code?: string }).code !== "METHOD_NOT_FOUND") throw error; }
  }
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
