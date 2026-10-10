import type { FileSystem } from "@oxbit/sdk";
import { workspaceEntries } from "@oxbit/workbench";

export type Mention =
  | { kind: "file"; path: string }
  | { kind: "selection" | "diagnostics" };

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
