type Request = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
type Change = { path: string; index: string; working: string };
type Diff = { diff: string; after: string; binary: boolean };

const MAX_FILES = 50;
export const MAX_CHANGES_TEXT = 200_000;

async function fileDiff(request: Request, change: Change) {
  try {
    if (change.index === "?") {
      const { after, binary } = await request<Diff>("git.diff", { path: change.path });
      return [binary ? `new binary file ${change.path}` : `new file ${change.path}\n${after}`];
    }
    const parts: string[] = [];
    for (const staged of [true, false]) {
      if ((staged ? change.index : change.working) === " ") continue;
      const { diff, binary } = await request<Diff>("git.diff", { path: change.path, staged });
      parts.push(binary ? `binary file changed ${change.path}` : diff);
    }
    return parts;
  } catch (error) {
    return [`${change.path}: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** Staged and unstaged changes as one patch; untracked files appear with their full text. */
export async function uncommittedChanges(request: Request) {
  const status = await request<{ repository: boolean; changes: Change[] }>("git.status");
  if (!status.repository) throw new Error("This workspace is not a git repository");
  if (!status.changes.length) throw new Error("No uncommitted changes");
  const parts: string[] = [];
  for (const change of status.changes.slice(0, MAX_FILES)) parts.push(...(await fileDiff(request, change)));
  if (status.changes.length > MAX_FILES)
    parts.push(`${status.changes.length - MAX_FILES} more changed files omitted`);
  const text = parts.join("\n");
  return text.length > MAX_CHANGES_TEXT
    ? `${text.slice(0, MAX_CHANGES_TEXT - 32)}\n[uncommitted changes truncated]`
    : text;
}
