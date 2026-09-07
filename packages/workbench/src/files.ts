import type { FileEntry, FileSystem } from "@zapp/sdk";

// Full traversal is reserved for explicit operations such as search and export.
// The explorer keeps its own shallow directory listings.
export async function* workspaceEntries(
  filesystem: FileSystem,
  options: {
    signal?: AbortSignal;
    exclude?: string[];
    skipUnavailable?: boolean;
  } = {},
): AsyncGenerator<FileEntry> {
  const pending = [""];
  for (let index = 0; index < pending.length; index++) {
    options.signal?.throwIfAborted();
    let entries: FileEntry[];
    try {
      entries = await filesystem.list(pending[index]);
    } catch (error) {
      if (options.skipUnavailable) continue;
      throw error;
    }
    options.signal?.throwIfAborted();
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (options.exclude?.includes(entry.name)) continue;
      yield entry;
      if (entry.kind === "directory") pending.push(entry.path);
    }
  }
}

export async function findWorkspaceFiles(
  filesystem: FileSystem,
  query: string,
  signal: AbortSignal,
): Promise<string[]> {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  const matches: string[] = [];
  for await (const entry of workspaceEntries(filesystem, {
    signal,
    exclude: [".git", "node_modules"],
    skipUnavailable: true,
  })) {
    if (entry.kind !== "file") continue;
    const path = entry.path.toLowerCase();
    let at = 0;
    if (
      [...term].every((char) => {
        const found = path.indexOf(char, at);
        at = found + 1;
        return found >= 0;
      })
    )
      matches.push(entry.path);
    if (matches.length >= 1000) break;
  }
  return matches;
}
