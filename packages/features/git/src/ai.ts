import type { GitChange, GitDiff, GitStatus } from "@oxbit/sdk";

/** The `ai` service shape from @oxbit/feature-ai, typed here so Source Control does not depend on it. */
export interface AiCompletion {
  complete(
    request: { system: string; prompt: string; maxTokens?: number },
    signal?: AbortSignal,
  ): Promise<string>;
}
export const AI_SERVICE_ID = "ai";
export const DIFF_BUDGET = 24_000;
const MAX_DIFF_FILES = 80;

export interface FileDiff {
  path: string;
  status: string;
  diff: string;
}
type Request = <T>(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<T>;

/** Splits `budget` characters across files: small diffs stay whole and large ones share the rest equally. */
export function budgetDiffs(files: FileDiff[], budget = DIFF_BUDGET): FileDiff[] {
  const limits = new Map<number, number>();
  let remaining = budget;
  const order = files
    .map((file, index) => ({ index, size: file.diff.length }))
    .sort((a, b) => a.size - b.size);
  order.forEach(({ index, size }, position) => {
    const share = Math.floor(remaining / (order.length - position));
    const take = Math.min(size, share);
    limits.set(index, take);
    remaining -= take;
  });
  return files.map((file, index) => {
    const limit = limits.get(index)!;
    return limit >= file.diff.length
      ? file
      : {
          ...file,
          diff:
            file.diff.slice(0, limit) +
            `\n… [${file.diff.length - limit} more characters omitted]`,
        };
  });
}

export function untrackedPatch(path: string, text: string) {
  return [`--- /dev/null`, `+++ b/${path}`, ...text.split("\n").map((line) => "+" + line)].join("\n");
}

const failureText = (failure: unknown) =>
  (failure as { code?: string }).code === "OUTPUT_LIMIT"
    ? "(diff too large to include)"
    : `(diff unavailable: ${(failure as Error).message ?? String(failure)})`;

async function fileDiff(request: Request, change: GitChange, staged: boolean, signal?: AbortSignal) {
  try {
    const data = await request<GitDiff>("diff", { path: change.path, staged }, signal);
    if (data.binary) return "(binary file changed)";
    if (!data.diff && !staged && change.working === "?") return untrackedPatch(change.path, data.after);
    return data.diff;
  } catch (failure) {
    if (signal?.aborted) throw failure;
    return failureText(failure);
  }
}

/** Reads per-file diffs through the host's `git.diff`; `staged` mode reads only the index. */
export async function collectDiffs(
  request: Request,
  changes: GitChange[],
  mode: "staged" | "all",
  signal?: AbortSignal,
): Promise<FileDiff[]> {
  const isStaged = (change: GitChange) => ![" ", "?", ""].includes(change.index);
  const isUnstaged = (change: GitChange) => ![" ", ""].includes(change.working);
  const results: FileDiff[] = changes.map((change) => ({
    path: change.path,
    status: (mode === "staged" ? change.index : isStaged(change) ? change.index : change.working).replace("?", "A"),
    diff: "(diff omitted: too many files)",
  }));
  let next = 0;
  const worker = async () => {
    while (next < Math.min(changes.length, MAX_DIFF_FILES)) {
      const index = next++;
      const change = changes[index]!;
      const parts: string[] = [];
      if (mode === "staged" || isStaged(change)) parts.push(await fileDiff(request, change, true, signal));
      if (mode === "all" && isUnstaged(change)) parts.push(await fileDiff(request, change, false, signal));
      results[index]!.diff = parts.filter(Boolean).join("\n");
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return results;
}

export function stripFences(text: string) {
  const fenced = /```[\w-]*\n([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

const styleSection = (subjects: string[]) =>
  subjects.length
    ? "Recent commit subjects in this repository (match their style):\n" +
      subjects.map((subject) => "- " + subject).join("\n")
    : "This repository has no commits yet.";
const filesSection = (files: FileDiff[]) =>
  "Changed files:\n" + files.map((file) => `${file.status} ${file.path}`).join("\n");
const diffSection = (files: FileDiff[], budget: number) =>
  "Diff:\n" +
  budgetDiffs(files, budget)
    .map((file) => `### ${file.path}\n${file.diff || "(no textual changes)"}`)
    .join("\n\n");
const MESSAGE_RULES =
  "one subject line under 72 characters in imperative mood, optionally followed by a blank line and a short body that explains why the change was made";

export function commitMessagePrompt(files: FileDiff[], subjects: string[], budget = DIFF_BUDGET) {
  return {
    system:
      `You write git commit messages. Reply with the commit message only: ${MESSAGE_RULES}. ` +
      "No code fences, quotes or preamble. Match the style of the repository's recent commits.",
    prompt: [styleSection(subjects), filesSection(files), diffSection(files, budget)].join("\n\n"),
    maxTokens: 400,
  };
}

export function cleanCommitMessage(text: string) {
  let message = stripFences(text).replace(/\r\n/g, "\n");
  if (/^(["'`]).*\1$/s.test(message)) message = message.slice(1, -1).trim();
  return message.replace(/\n{3,}/g, "\n\n");
}

export function commitPlanPrompt(files: FileDiff[], subjects: string[], budget = DIFF_BUDGET) {
  return {
    system:
      "You split working tree changes into logical git commits. Reply with JSON only, no code fences: " +
      '[{ "message": string, "files": string[] }]. List commits in the order they should be made. ' +
      "Use only paths from the changed file list and put each path in exactly one commit. " +
      `Each message has ${MESSAGE_RULES}. Match the style of the repository's recent commits.`,
    prompt: [styleSection(subjects), filesSection(files), diffSection(files, budget)].join("\n\n"),
    maxTokens: 2000,
  };
}

function extractJson(text: string, open: string, close: string): unknown {
  const body = stripFences(text);
  const start = body.indexOf(open),
    end = body.lastIndexOf(close);
  if (start < 0 || end < start) throw new Error("The AI response did not contain JSON");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new Error("The AI response contained invalid JSON");
  }
}

/** A file in a planned commit; `originalPath` is the source of a staged rename. */
export interface PlannedFile {
  path: string;
  originalPath?: string;
}

export interface PlannedCommit {
  message: string;
  files: PlannedFile[];
}

/** Keeps known paths once each, moves unassigned paths to a final commit and drops empty commits. */
export function parseCommitPlan(text: string, changes: PlannedFile[]): PlannedCommit[] {
  const data = extractJson(text, "[", "]");
  if (!Array.isArray(data)) throw new Error("The AI response was not a list of commits");
  const known = new Map(changes.map((change) => [change.path, change])),
    used = new Set<string>(),
    plan: PlannedCommit[] = [];
  const file = (path: string): PlannedFile => {
    const originalPath = known.get(path)?.originalPath;
    return originalPath ? { path, originalPath } : { path };
  };
  for (const item of data as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { message, files } = item as { message?: unknown; files?: unknown };
    const assigned = (Array.isArray(files) ? files : [])
      .filter((file): file is string => typeof file === "string")
      .map((file) => file.replace(/^\.\//, ""))
      .filter((file) => known.has(file) && !used.has(file));
    assigned.forEach((file) => used.add(file));
    if (assigned.length)
      plan.push({
        message: typeof message === "string" && message.trim() ? cleanCommitMessage(message) : `Update ${assigned[0]}`,
        files: assigned.map(file),
      });
  }
  const rest = [...known.keys()].filter((path) => !used.has(path));
  if (rest.length) plan.push({ message: "Update remaining files", files: rest.map(file) });
  return plan;
}

export function pullRequestPrompt(
  input: { base: string; head: string; commits: string[]; files: FileDiff[] },
  budget = DIFF_BUDGET,
) {
  return {
    system:
      'You write GitHub pull request text. Reply with JSON only, no code fences: { "title": string, "body": string }. ' +
      "The title is under 72 characters in imperative mood. The body is Markdown that explains what changed and why.",
    prompt: [
      `Branch ${input.head} into ${input.base}.`,
      "Commits:\n" + (input.commits.map((subject) => "- " + subject).join("\n") || "(none)"),
      filesSection(input.files),
      diffSection(input.files, budget),
    ].join("\n\n"),
    maxTokens: 1200,
  };
}

export function parsePullRequest(text: string) {
  const data = extractJson(text, "{", "}") as { title?: unknown; body?: unknown };
  const title = typeof data?.title === "string" ? data.title.trim() : "";
  if (!title) throw new Error("The AI response had no pull request title");
  return { title, body: typeof data.body === "string" ? data.body.trim() : "" };
}

/** The remote a pull request targets when its push URL is on github.com. */
export function pullRequestRemote(status: GitStatus) {
  const upstream = status.upstream
    ? status.remotes
        .filter((remote) => status.upstream!.startsWith(remote.name + "/"))
        .sort((a, b) => b.name.length - a.name.length)[0]
    : undefined;
  const remote =
    upstream ??
    status.remotes.find((remote) => remote.name === "origin") ??
    (status.remotes.length === 1 ? status.remotes[0] : undefined);
  return remote && /(^|[@/.])github\.com[/:]/.test(remote.pushUrl || remote.fetchUrl)
    ? remote.name
    : undefined;
}
