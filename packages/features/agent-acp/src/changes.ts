import type { GitBranchDiff, GitCommitDetail } from "@oxbit/sdk";

type Request = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
type Change = { path: string; index: string; working: string };
type Diff = { diff: string; after: string; binary: boolean };

const MAX_FILES = 50;
export const MAX_CHANGES_TEXT = 200_000;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const cap = (text: string, marker: string) =>
  text.length > MAX_CHANGES_TEXT ? `${text.slice(0, MAX_CHANGES_TEXT - marker.length - 3)}\n[${marker}]` : text;

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
    return [`${change.path}: ${message(error)}`];
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
  return cap(parts.join("\n"), "uncommitted changes truncated");
}

/** The branch's committed and uncommitted changes since its merge base with the base branch. */
export async function branchChanges(request: Request) {
  const result = await request<GitBranchDiff>("git.branchDiff");
  if ("repository" in result) throw new Error("This workspace is not a git repository");
  if (!result.files.length) throw new Error(`No changes against ${result.base}`);
  const parts = result.files.map((file) =>
    file.binary ? `binary file changed ${file.path}` : file.diff || `${file.path}: diff exceeds the size limit`);
  if (result.truncated) parts.push("[branch diff truncated]");
  const head = `Changes on ${result.head} since its merge base with ${result.base}, including uncommitted changes\n\n`;
  return { label: `Branch diff: ${result.base}...${result.head}`, text: cap(head + parts.join("\n"), "branch diff truncated") };
}

/** A commit's message and the diff of up to 50 of its files. */
export async function commitChanges(request: Request, ref: string) {
  const { commit, files } = await request<GitCommitDetail>("git.show", { ref });
  const parts = [`commit ${commit.id}`, `Author: ${commit.author}`, `Date: ${commit.date}`, "", commit.subject];
  if (commit.body) parts.push("", commit.body);
  parts.push("");
  let size = parts.join("\n").length;
  for (const file of files.slice(0, MAX_FILES)) {
    if (size > MAX_CHANGES_TEXT) break;
    try {
      const { diff, binary } = await request<Diff>("git.commitDiff", { ref: commit.id, path: file.path });
      parts.push(binary ? `binary file changed ${file.path}` : diff);
    } catch (error) {
      parts.push(`${file.path}: ${message(error)}`);
    }
    size += parts.at(-1)!.length + 1;
  }
  if (files.length > MAX_FILES) parts.push(`${files.length - MAX_FILES} more changed files omitted`);
  return cap(parts.join("\n"), "commit truncated");
}
