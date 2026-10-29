import type { GitChange } from "@oxbit/sdk";
import type { PlannedCommit, PlannedFile } from "./ai.js";

type Request = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const isStaged = (change: GitChange) => change.index !== " " && change.index !== "?";
/** Staged with further unstaged edits: staging the whole file again loses the split. */
export const partiallyStaged = (change: GitChange) =>
  isStaged(change) && change.working !== " " && change.working !== "?";
const pathsOf = (file: PlannedFile) => (file.originalPath ? [file.path, file.originalPath] : [file.path]);

export class CommitPlanError extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(message);
  }
}

/** Without `preserveIndex` (no index snapshot on the host), changes that were staged are staged again in full. */
export async function runCommitPlan({
  request,
  changes,
  plan,
  preserveIndex,
  step,
}: {
  request: Request;
  changes: GitChange[];
  plan: PlannedCommit[];
  preserveIndex: boolean;
  step(index: number): void;
}) {
  const tree = preserveIndex ? (await request<{ tree: string }>("indexSnapshot")).tree : undefined;
  const committed = new Set<string>();
  let failure: CommitPlanError | undefined;
  for (const [index, entry] of plan.entries()) {
    step(index);
    try {
      await request("unstageAll");
      for (const path of entry.files.flatMap(pathsOf)) await request("stage", { path });
      await request("commit", { message: entry.message });
    } catch (reason) {
      failure = new CommitPlanError(index, messageOf(reason));
      break;
    }
    for (const path of entry.files.flatMap(pathsOf)) committed.add(path);
  }
  const rest = changes.filter((change) => !committed.has(change.path));
  try {
    if (tree) {
      const paths = rest.flatMap(pathsOf);
      if (paths.length) await request("indexRestore", { tree, paths });
    } else {
      await request("unstageAll");
      for (const path of rest.filter(isStaged).flatMap(pathsOf)) await request("stage", { path });
    }
  } catch (reason) {
    if (!failure) throw reason;
    failure.message += `; ${messageOf(reason)}`;
  }
  if (failure) throw failure;
}
