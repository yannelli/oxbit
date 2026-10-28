import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type {
  GitStatus,
  GitChange,
  GitCommit,
  GitLineCounts,
  GitCommitFile,
  GitStash,
  GitDiff,
  GitBranchDiff,
} from "@oxbit/sdk";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { RpcError, MAX_MESSAGE_BYTES } from "@oxbit/protocol";
import { runCommand, killProcess } from "./processes.js";
import { trackChild } from "./owned-processes.js";
import { WorkspaceFiles } from "./filesystem.js";
export interface InputCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export type InputCommand = (
  command: string,
  args: string[],
  options: { cwd: string; input: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<InputCommandResult>;
const OUTPUT_CAP = 1_000_000;
/** Runs a command without a shell and writes `input` to its stdin. */
export const runWithInput: InputCommand = (command, args, { cwd, input, env, signal }) => {
  if (signal?.aborted)
    return Promise.reject(new RpcError("CANCELLED", "Operation was cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    trackChild(child);
    let stdout = "",
      stderr = "";
    const cancel = () => killProcess(child);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      signal?.removeEventListener("abort", cancel);
      reject(error);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted)
        reject(new RpcError("CANCELLED", "Operation was cancelled"));
      else resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.end(input);
  });
};
export const GH_SETUP = "Install the GitHub CLI and run gh auth login";
export function pullRequestArgs(title: string, base: string) {
  return ["pr", "create", "--draft", "--title", title, "--body-file", "-", "--base", base];
}
/** Maps a failed `gh` spawn or exit to an RpcError with a message the panel can show. */
export function pullRequestError(failure: unknown): RpcError {
  if (failure instanceof RpcError) return failure;
  const value = failure as Partial<InputCommandResult> & { code?: string; message?: string };
  if (value.code === "ENOENT") return new RpcError("GH_UNAVAILABLE", GH_SETUP);
  const output = (value.stderr ?? "").trim() || (value.stdout ?? "").trim();
  if (/gh auth login|not logged in|authentication required|HTTP 401/i.test(output))
    return new RpcError("GH_UNAVAILABLE", GH_SETUP);
  return new RpcError(
    "GH_FAILED",
    output || value.message || `gh exited ${value.exitCode ?? 1}`,
  );
}
export function pullRequestUrl(stdout: string) {
  const url = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (!/^https:\/\/\S+$/.test(url))
    throw new RpcError("GH_FAILED", stdout.trim() || "gh did not return a pull request URL");
  return url;
}
const validBranch = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value &&
  !value.startsWith("-") &&
  !value.includes("\0") &&
  value.length <= 240;
function bounded<T>(value: T): T {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    MAX_MESSAGE_BYTES - 4096
  )
    throw new RpcError(
      "OUTPUT_LIMIT",
      "This Git result is too large to preview. Narrow the history filter or use whole-file actions.",
    );
  return value;
}
const BRANCH_DIFF_FILES = 50;
const BRANCH_DIFF_TEXT = 200_000;
const conflicted = (index: string, working: string) =>
  ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(index + working);
const UNTRACKED_COUNT_FILES = 50;
const UNTRACKED_COUNT_BYTES = 1_000_000;
const BINARY_PROBE_BYTES = 8192;
/** Parses `git diff --numstat -z`; binary files (`-`) are left out. */
function numstat(output: string) {
  const counts = new Map<string, GitLineCounts>();
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(records[i]!);
    if (!match) continue;
    let file = match[3]!;
    if (!file) {
      i += 2;
      file = records[i] ?? "";
    }
    if (file && match[1] !== "-" && match[2] !== "-")
      counts.set(file, { added: Number(match[1]), removed: Number(match[2]) });
  }
  return counts;
}
async function textLines(file: string) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > UNTRACKED_COUNT_BYTES) return undefined;
    const data = await handle.readFile();
    if (data.subarray(0, BINARY_PROBE_BYTES).includes(0)) return undefined;
    let lines = 0;
    for (const byte of data) if (byte === 10) lines++;
    if (data.length && data[data.length - 1] !== 10) lines++;
    return lines;
  } finally {
    await handle.close();
  }
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class Git {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private files: WorkspaceFiles,
    private executable = "git",
    private runInput: InputCommand = runWithInput,
  ) {}
  private async gh(args: string[], cwd: string, input: string, signal?: AbortSignal) {
    let result: InputCommandResult;
    try {
      result = await this.runInput("gh", args, {
        cwd,
        input,
        signal,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
    } catch (error) {
      throw pullRequestError(error);
    }
    if (result.exitCode) throw pullRequestError(result);
    return result;
  }
  /** The remote's default branch from `gh repo view`, then the upstream remote's HEAD, origin/HEAD, main or master. */
  private async defaultBranch(root: string, status: GitStatus, signal?: AbortSignal) {
    try {
      const name = (
        await this.gh(["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], root, "", signal)
      ).stdout.trim();
      if (validBranch(name)) return name;
    } catch (error) {
      if ((error as RpcError).code === "CANCELLED") throw error;
    }
    const base = await this.baseBranch(status.branch, signal);
    if (!base) return undefined;
    const remote = status.remotes.find((remote) => base.name.startsWith(remote.name + "/"));
    return remote ? base.name.slice(remote.name.length + 1) : base.name;
  }
  private async run(
    args: string[],
    signal?: AbortSignal,
    cwd = this.files.root,
    onData?: (data: string) => void,
    acceptFailure = false,
  ) {
    const result = await runCommand(
      this.executable,
      ["--literal-pathspecs", "-c", "color.ui=false", ...args],
      {
        cwd,
        signal,
        onData,
        maxBytes: MAX_MESSAGE_BYTES,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
          GIT_MERGE_AUTOEDIT: "no",
          LC_ALL: "C",
        },
      },
    );
    if (result.exitCode && !acceptFailure)
      throw new RpcError(
        "GIT_FAILED",
        result.stderr.trim() ||
          result.stdout.trim() ||
          `Git exited ${result.exitCode}`,
        { exitCode: result.exitCode },
      );
    return result;
  }
  private async optional(args: string[], signal?: AbortSignal) {
    return this.run(args, signal, this.files.root, undefined, true);
  }
  private async head(signal?: AbortSignal) {
    const result = await this.optional(
      ["rev-parse", "--verify", "HEAD"],
      signal,
    );
    return result.exitCode ? undefined : result.stdout.trim();
  }
  private async commitId(ref: unknown, signal?: AbortSignal) {
    if (
      typeof ref !== "string" ||
      !ref ||
      ref.startsWith("-") ||
      ref.includes("\0") ||
      ref.length > 1024
    )
      throw new RpcError("INVALID_PARAMS", "Choose a valid commit or branch");
    return (
      await this.run(
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        signal,
      )
    ).stdout.trim();
  }
  private async branchName(value: unknown, signal: AbortSignal) {
    if (
      typeof value !== "string" ||
      !value ||
      value.startsWith("-") ||
      value.startsWith("refs/") ||
      value.includes("@{") ||
      value.length > 240
    )
      throw new RpcError("INVALID_PARAMS", "Enter a valid branch name");
    // Validate the full ref: --branch accepts @{-1}, which should never select a different branch here.
    await this.run(["check-ref-format", `refs/heads/${value}`], signal);
    return value;
  }
  async status(signal?: AbortSignal): Promise<GitStatus> {
    const inside = await this.optional(
      ["rev-parse", "--is-inside-work-tree"],
      signal,
    );
    if (inside.exitCode || inside.stdout.trim() !== "true") {
      if (inside.exitCode && !inside.stderr.includes("not a git repository"))
        throw new RpcError("GIT_FAILED", inside.stderr.trim());
      return {
        repository: false,
        branch: "",
        branches: [],
        refs: [],
        changes: [],
        remotes: [],
        ahead: 0,
        behind: 0,
      };
    }
    const [raw, unstagedDiff, stagedDiff, top, branch, refs, remotes, head] = await Promise.all([
      this.run(
        ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
        signal,
      ),
      this.optional(["diff", "--numstat", "-z"], signal),
      this.optional(["diff", "--cached", "--numstat", "-z"], signal),
      this.run(["rev-parse", "--show-toplevel"], signal),
      this.optional(["symbolic-ref", "--short", "HEAD"], signal),
      this.run(
        [
          "for-each-ref",
          "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(objectname)%00%(subject)%00%(symref)",
          "refs/heads",
          "refs/remotes",
        ],
        signal,
      ),
      this.run(["remote", "-v"], signal),
      this.head(signal),
    ]);
    const changes: GitChange[] = [];
    const records = raw.stdout.split("\0");
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      if (!row) continue;
      const change: GitChange = {
        path: row.slice(3),
        index: row[0]!,
        working: row[1]!,
        conflict: conflicted(row[0]!, row[1]!),
      };
      if (/[RC]/.test(change.index + change.working))
        change.originalPath = records[++i];
      changes.push(change);
    }
    const stagedCounts = numstat(stagedDiff.exitCode ? "" : stagedDiff.stdout);
    const unstagedCounts = numstat(
      unstagedDiff.exitCode ? "" : unstagedDiff.stdout,
    );
    const root = top.stdout.trim();
    let untrackedCounted = 0;
    for (const change of changes) {
      if (change.index === "?") {
        if (untrackedCounted++ >= UNTRACKED_COUNT_FILES) continue;
        const added = await textLines(path.join(root, change.path)).catch(
          () => undefined,
        );
        if (added !== undefined) change.unstaged = { added, removed: 0 };
        continue;
      }
      const staged = change.index !== " " && stagedCounts.get(change.path);
      const unstaged =
        change.working !== " " && unstagedCounts.get(change.path);
      if (staged) change.staged = staged;
      if (unstaged) change.unstaged = unstaged;
    }
    const branches = refs.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        const [ref, current, upstream, commit, subject, symref] =
          row.split("\0");
        return {
          ref: ref!,
          name: ref!.replace(/^refs\/(heads|remotes)\//, ""),
          remote: ref!.startsWith("refs/remotes/"),
          current: current === "*",
          upstream: upstream || undefined,
          commit: commit!,
          subject: subject!,
          symref,
        };
      })
      .filter((branch) => !branch.symref);
    const remoteMap = new Map<
      string,
      { name: string; fetchUrl: string; pushUrl: string }
    >();
    for (const row of remotes.stdout.trim().split("\n")) {
      const match = /^(.*?)\t(.*) \((fetch|push)\)$/.exec(row);
      if (!match) continue;
      const item = remoteMap.get(match[1]!) ?? {
        name: match[1]!,
        fetchUrl: "",
        pushUrl: "",
      };
      if (match[3] === "fetch") item.fetchUrl = match[2]!;
      else item.pushUrl = match[2]!;
      remoteMap.set(item.name, item);
    }
    const upstream = branches.find((branch) => branch.current)?.upstream;
    let ahead = 0,
      behind = 0;
    if (head && upstream) {
      const counts = await this.optional(
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}", "--"],
        signal,
      );
      if (!counts.exitCode)
        [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number) as [
          number,
          number,
        ];
    }
    let operation: GitStatus["operation"];
    for (const [marker, kind] of [
      ["rebase-merge", "rebase"],
      ["rebase-apply", "rebase"],
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
    ] as const) {
      const markerPath = (
        await this.run(["rev-parse", "--git-path", marker], signal)
      ).stdout.trim();
      try {
        await fs.access(path.resolve(this.files.root, markerPath));
        operation = kind;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return {
      repository: true,
      branch:
        branch.stdout.trim() || `(detached ${head?.slice(0, 7) ?? "HEAD"})`,
      branches: branches
        .filter((branch) => !branch.remote)
        .map((branch) => branch.name),
      refs: branches,
      changes,
      remotes: [...remoteMap.values()],
      head,
      upstream,
      ahead,
      behind,
      operation,
    };
  }
  private async patch(relative: string, staged: boolean, signal?: AbortSignal) {
    return (
      await this.run(
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--unified=3",
          ...(staged ? ["--cached"] : []),
          "--",
          relative,
        ],
        signal,
      )
    ).stdout;
  }
  async diff(
    relative: string,
    staged = false,
    signal?: AbortSignal,
  ): Promise<GitDiff> {
    await this.files.resolve(relative, true);
    const diff = await this.patch(relative, staged, signal);
    const change = (await this.status(signal)).changes.find(
      (change) => change.path === relative,
    );
    const before = await this.optional(
      [
        "show",
        staged ? `HEAD:${change?.originalPath ?? relative}` : `:${relative}`,
      ],
      signal,
    );
    let after = "";
    if (staged)
      after = (await this.optional(["show", `:${relative}`], signal)).stdout;
    else {
      try {
        const full = await this.files.resolve(relative, true);
        if ((await fs.stat(full)).size > MAX_MESSAGE_BYTES / 2)
          throw new RpcError(
            "OUTPUT_LIMIT",
            "This file is too large to preview. Use whole-file actions.",
          );
        after = (await fs.readFile(full)).toString("utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const binary =
      diff.includes("Binary files ") ||
      before.stdout.includes("\0") ||
      after.includes("\0");
    const pieces = diff.split(/(?=^@@ )/m);
    // Whole-file actions handle renames, creations, deletions, mode changes, and conflicts.
    const canHunk =
      !binary &&
      !change?.conflict &&
      !change?.originalPath &&
      pieces.length > 1 &&
      !/^(new file|deleted file|old mode|new mode|diff --cc)/m.test(diff) &&
      (diff.match(/^diff --git /gm)?.length ?? 0) === 1;
    return bounded({
      before: binary ? "" : before.exitCode ? "" : before.stdout,
      after: binary ? "" : after,
      diff,
      binary,
      fingerprint: digest(diff),
      hunks: canHunk
        ? pieces.slice(1).map((patch, index) => ({
            index,
            header: patch.split("\n")[0]!,
            patch,
          }))
        : [],
    });
  }
  private parseCommits(output: string): GitCommit[] {
    const fields = output.split("\0"),
      commits: GitCommit[] = [];
    for (let i = 0; i + 6 < fields.length; i += 7)
      if (fields[i])
        commits.push({
          id: fields[i]!,
          parents: fields[i + 1]!.split(" ").filter(Boolean),
          author: fields[i + 2]!,
          date: fields[i + 3]!,
          subject: fields[i + 4]!,
          body: fields[i + 5]!.trim(),
          refs: fields[i + 6]!.trim(),
        });
    return commits;
  }
  async log(params: Record<string, unknown>, signal?: AbortSignal) {
    const limit = Number(params.limit ?? 40),
      skip = Number(params.skip ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(skip) ||
      skip < 0 ||
      skip > 100000
    )
      throw new RpcError("INVALID_PARAMS", "Invalid history page");
    const head = params.ref
      ? await this.commitId(params.ref, signal)
      : await this.head(signal);
    if (!head) return { commits: [], hasMore: false };
    if (params.path !== undefined) {
      if (typeof params.path !== "string")
        throw new RpcError("INVALID_PARAMS", "Invalid path");
      await this.files.resolve(params.path, true);
    }
    if (
      params.search !== undefined &&
      (typeof params.search !== "string" || params.search.length > 1024)
    )
      throw new RpcError("INVALID_PARAMS", "Invalid search");
    const output = await this.run(
      [
        "log",
        "--date-order",
        "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b%x00%D",
        "-z",
        `--max-count=${limit + 1}`,
        `--skip=${skip}`,
        ...(params.search
          ? [
              "--fixed-strings",
              "--regexp-ignore-case",
              `--grep=${params.search}`,
            ]
          : []),
        head,
        "--",
        ...(params.path ? [String(params.path)] : []),
      ],
      signal,
    );
    const commits = this.parseCommits(output.stdout);
    return {
      commits: commits.slice(0, limit),
      hasMore: commits.length > limit,
    };
  }
  private parseFiles(output: string): GitCommitFile[] {
    const fields = output.split("\0"),
      files: GitCommitFile[] = [];
    for (let i = 0; i < fields.length - 1;) {
      const status = fields[i++]!;
      if (!status) break;
      const first = fields[i++]!;
      files.push(
        /[RC]/.test(status[0]!)
          ? { status, originalPath: first, path: fields[i++]! }
          : { status, path: first },
      );
    }
    return files;
  }
  async show(ref: unknown, signal?: AbortSignal) {
    const id = await this.commitId(ref, signal);
    const commit = (await this.log({ ref: id, limit: 1 }, signal)).commits[0]!;
    const files = await this.run(
      [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-M",
        "-z",
        ...(commit.parents[0] ? [commit.parents[0], id] : [id]),
        "--",
      ],
      signal,
    );
    return bounded({ commit, files: this.parseFiles(files.stdout) });
  }
  async commitDiff(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GitDiff> {
    if (typeof params.path !== "string")
      throw new RpcError("INVALID_PARAMS", "A file path is required");
    await this.files.resolve(params.path, true);
    const detail = await this.show(params.ref, signal),
      file = detail.files.find((file) => file.path === params.path);
    if (!file)
      throw new RpcError("NOT_FOUND", "File is not part of this commit");
    const before = detail.commit.parents[0]
      ? await this.optional(
          [
            "show",
            `${detail.commit.parents[0]}:${file.originalPath ?? file.path}`,
          ],
          signal,
        )
      : undefined;
    const after = await this.optional(
      ["show", `${detail.commit.id}:${file.path}`],
      signal,
    );
    const diff = await this.run(
      [
        "show",
        "--format=",
        "--first-parent",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        detail.commit.id,
        "--",
        file.path,
        ...(file.originalPath ? [file.originalPath] : []),
      ],
      signal,
    );
    const binary =
      diff.stdout.includes("Binary files ") ||
      before?.stdout.includes("\0") ||
      after.stdout.includes("\0");
    return bounded({
      before: binary || before?.exitCode ? "" : (before?.stdout ?? ""),
      after: binary || after.exitCode ? "" : after.stdout,
      diff: diff.stdout,
      binary: !!binary,
    });
  }
  async stashes(signal?: AbortSignal): Promise<GitStash[]> {
    const result = await this.run(
      ["stash", "list", "--format=%H%x00%gd%x00%gs%x00%aI", "-z"],
      signal,
    );
    const fields = result.stdout.split("\0"),
      stashes: GitStash[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4)
      stashes.push({
        id: fields[i]!,
        ref: fields[i + 1]!,
        message: fields[i + 2]!,
        date: fields[i + 3]!,
      });
    return bounded(stashes);
  }
  private async stash(params: Record<string, unknown>, signal?: AbortSignal) {
    const stash = (await this.stashes(signal)).find(
      (stash) => stash.id === params.id && stash.ref === params.ref,
    );
    if (!stash)
      throw new RpcError(
        "STALE_STATE",
        "The stash list changed. Refresh it before retrying.",
      );
    return stash;
  }
  async stashDiff(params: Record<string, unknown>, signal?: AbortSignal) {
    const stash = await this.stash(params, signal);
    return bounded({
      diff: (
        await this.run(
          [
            "stash",
            "show",
            "--include-untracked",
            "--patch",
            "--no-ext-diff",
            "--no-textconv",
            stash.id,
          ],
          signal,
        )
      ).stdout,
    });
  }
  /** The upstream remote's default branch, then `origin/HEAD`, then local `main` or `master`. */
  private async baseBranch(branch: string, signal?: AbortSignal) {
    const remote = branch
      ? (await this.optional(["config", "--get", `branch.${branch}.remote`], signal)).stdout.trim()
      : "";
    const candidates = [
      ...(remote && remote !== "." ? [`refs/remotes/${remote}/HEAD`] : []),
      "refs/remotes/origin/HEAD",
      "refs/heads/main",
      "refs/heads/master",
    ];
    for (const ref of candidates) {
      const commit = await this.optional(
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
        signal,
      );
      if (commit.exitCode) continue;
      const name = await this.optional(["rev-parse", "--abbrev-ref", ref], signal);
      return { name: name.stdout.trim() || ref, commit: commit.stdout.trim() };
    }
    return undefined;
  }
  private async untrackedPatch(relative: string, signal?: AbortSignal) {
    const result = await this.run(
      ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", relative],
      signal,
      this.files.root,
      undefined,
      true,
    );
    if (result.exitCode > 1)
      throw new RpcError("GIT_FAILED", result.stderr.trim() || `Git exited ${result.exitCode}`);
    return result.stdout;
  }
  /** Committed, staged, unstaged and untracked changes since the merge base with the base branch. */
  async branchDiff(params: Record<string, unknown>, signal?: AbortSignal): Promise<GitBranchDiff> {
    const limit = Number(params.limit ?? BRANCH_DIFF_FILES);
    if (!Number.isInteger(limit) || limit < 0 || limit > BRANCH_DIFF_FILES)
      throw new RpcError("INVALID_PARAMS", "Invalid file limit");
    const inside = await this.optional(["rev-parse", "--is-inside-work-tree"], signal);
    if (inside.exitCode || inside.stdout.trim() !== "true") {
      if (inside.exitCode && !inside.stderr.includes("not a git repository"))
        throw new RpcError("GIT_FAILED", inside.stderr.trim());
      return { repository: false };
    }
    const head = await this.head(signal);
    if (!head) throw new RpcError("NOT_FOUND", "This branch has no commits yet");
    const branch = (await this.optional(["symbolic-ref", "-q", "--short", "HEAD"], signal)).stdout.trim();
    const base = await this.baseBranch(branch, signal);
    if (!base) throw new RpcError("NOT_FOUND", "No base branch: origin/HEAD, main and master are missing");
    const mergeBase = await this.optional(["merge-base", base.commit, head], signal);
    if (mergeBase.exitCode)
      throw new RpcError("NOT_FOUND", `${branch || "HEAD"} has no common history with ${base.name}`);
    const from = mergeBase.stdout.trim();
    const names = async (args: string[]) => (await this.run(args, signal)).stdout.split("\0").filter(Boolean);
    const tracked = await names(["diff", "--name-only", "--relative", "-z", from, "--"]);
    const untracked = await names(["ls-files", "--others", "--exclude-standard", "-z", "--"]);
    const files: { path: string; diff: string; binary: boolean }[] = [];
    let size = 0,
      truncated = false;
    for (const [index, relative] of [...tracked, ...untracked].entries()) {
      if (files.length >= limit || size >= BRANCH_DIFF_TEXT) {
        truncated = true;
        break;
      }
      let diff = "";
      try {
        diff = index < tracked.length
          ? (await this.run(
            ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--relative", "--src-prefix=a/", "--dst-prefix=b/", from, "--", relative],
            signal,
          )).stdout
          : await this.untrackedPatch(relative, signal);
      } catch (error) {
        if ((error as RpcError).code !== "OUTPUT_LIMIT") throw error;
        truncated = true;
      }
      const binary = /^Binary files /m.test(diff);
      if (size + diff.length > BRANCH_DIFF_TEXT) {
        diff = diff.slice(0, BRANCH_DIFF_TEXT - size);
        truncated = true;
      }
      size += diff.length;
      files.push({ path: relative, diff, binary });
    }
    return bounded({ base: base.name, head: branch || head.slice(0, 7), files, truncated });
  }
  async action(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    progress: (data: string) => void,
  ) {
    const pending = this.queue
      .catch(() => {})
      .then(() => this.execute(method, params, signal, progress));
    this.queue = pending;
    return pending;
  }
  private remoteUrl(value: unknown) {
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      value.includes("\0") ||
      !/^(?:https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:|file:\/\/)/.test(value)
    )
      throw new RpcError(
        "INVALID_PARAMS",
        "Use an HTTPS, SSH, or file repository URL",
      );
  }
  private async remote(value: unknown, signal: AbortSignal) {
    const remote = (await this.status(signal)).remotes.find(
      (remote) => remote.name === value,
    );
    if (!remote || remote.name.startsWith("-"))
      throw new RpcError("NOT_FOUND", "Choose an existing remote");
    return remote.name;
  }
  private async execute(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    progress: (data: string) => void,
  ) {
    if (signal.aborted)
      throw new RpcError("CANCELLED", "Operation was cancelled");
    const relative = typeof params.path === "string" ? params.path : "";
    if (["stage", "unstage", "discard"].includes(method)) {
      if (!relative)
        throw new RpcError("INVALID_PARAMS", "A file path is required");
      await this.files.resolve(relative, true);
    }
    switch (method) {
      case "init":
        await this.run(["init"], signal);
        break;
      case "stage":
        {
          const change = (await this.status(signal)).changes.find(
            (change) => change.path === relative,
          );
          await this.run(
            [
              "add",
              "-A",
              "--",
              relative,
              ...(change?.originalPath ? [change.originalPath] : []),
            ],
            signal,
          );
        }
        break;
      case "unstage": {
        const original = (await this.status(signal)).changes.find(
          (change) => change.path === relative,
        )?.originalPath;
        const head = await this.run(
          ["rev-parse", "--verify", "HEAD"],
          signal,
          this.files.root,
          undefined,
          true,
        );
        await this.run(
          head.exitCode
            ? ["rm", "--cached", "-f", "--", relative]
            : [
                "reset",
                "HEAD",
                "--",
                relative,
                ...(original ? [original] : []),
              ],
          signal,
        );
        break;
      }
      case "discard": {
        if (params.confirm !== true)
          throw new RpcError(
            "CONFIRM_REQUIRED",
            "Confirm discarding disk changes",
          );
        const tracked = await this.run(
          ["ls-files", "--error-unmatch", "--", relative],
          signal,
          this.files.root,
          undefined,
          true,
        );
        if (tracked.exitCode) await this.files.delete(relative);
        else await this.run(["restore", "--worktree", "--", relative], signal);
        break;
      }
      case "restore": {
        if (!relative)
          throw new RpcError("INVALID_PARAMS", "A file path is required");
        await this.files.resolve(relative, true);
        const content = await this.run(["show", `HEAD:${relative}`], signal);
        return this.files.write(relative, content.stdout, {
          expectedRevision: null,
        });
      }
      case "commit": {
        if (typeof params.message !== "string" || !params.message.trim())
          throw new RpcError("INVALID_PARAMS", "Commit message is required");
        await this.run(["commit", "-m", params.message], signal);
        return {
          commit: (await this.run(["rev-parse", "HEAD"], signal)).stdout.trim(),
        };
      }
      case "amend": {
        if (!(await this.head(signal)))
          throw new RpcError("NOT_FOUND", "There is no commit to amend");
        const message =
          typeof params.message === "string" && params.message.trim()
            ? params.message
            : undefined;
        await this.run(
          ["commit", "--amend", ...(message ? ["-m", message] : ["--no-edit"])],
          signal,
        );
        return {
          commit: (await this.run(["rev-parse", "HEAD"], signal)).stdout.trim(),
        };
      }
      case "createPullRequest": {
        const title = typeof params.title === "string" ? params.title.trim() : "";
        if (!title || title.length > 256)
          throw new RpcError("INVALID_PARAMS", "Enter a pull request title");
        const body = params.body ?? "";
        if (typeof body !== "string" || body.length > 65536)
          throw new RpcError("INVALID_PARAMS", "The pull request body is too long");
        if (params.base !== undefined && !validBranch(params.base))
          throw new RpcError("INVALID_PARAMS", "Choose a valid base branch");
        const status = await this.status(signal);
        if (!status.head || !status.branches.includes(status.branch))
          throw new RpcError("INVALID_PARAMS", "Create a commit on a local branch first");
        if (!status.upstream)
          throw new RpcError("NO_UPSTREAM", "Publish this branch before creating a pull request");
        const root = (await this.run(["rev-parse", "--show-toplevel"], signal)).stdout.trim();
        const base = (params.base as string | undefined) ?? (await this.defaultBranch(root, status, signal));
        if (!base) throw new RpcError("NOT_FOUND", "Choose a base branch for the pull request");
        const result = await this.gh(pullRequestArgs(title, base), root, body, signal);
        return { url: pullRequestUrl(result.stdout) };
      }
      case "stageAll":
        if (
          (await this.status(signal)).changes.some((change) => change.conflict)
        )
          throw new RpcError(
            "CONFLICT",
            "Resolve and stage conflicted files individually first",
          );
        await this.run(["add", "-A", "--", "."], signal);
        break;
      case "unstageAll":
        await this.run(
          (await this.head(signal))
            ? ["reset", "HEAD", "--", "."]
            : ["rm", "--cached", "-r", "-f", "--", "."],
          signal,
        );
        break;
      case "hunk": {
        if (!relative)
          throw new RpcError("INVALID_PARAMS", "A file path is required");
        const diff = await this.diff(relative, params.staged === true, signal);
        if (diff.fingerprint !== params.fingerprint)
          throw new RpcError(
            "STALE_STATE",
            "The diff changed. Refresh it before staging a hunk.",
          );
        const hunk = diff.hunks?.find((hunk) => hunk.index === params.hunk);
        if (!hunk)
          throw new RpcError(
            "INVALID_PARAMS",
            "This change requires a whole-file action",
          );
        const header = diff.diff.split(/^@@ /m)[0]!;
        const directory = await fs.mkdtemp(
          path.join(os.tmpdir(), "oxbit-git-patch-"),
        );
        try {
          const file = path.join(directory, "change.patch");
          await fs.writeFile(file, header + hunk.patch, { mode: 0o600 });
          await this.run(
            [
              "apply",
              "--cached",
              "--whitespace=nowarn",
              ...(params.staged === true ? ["--reverse"] : []),
              "--",
              file,
            ],
            signal,
          );
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
        break;
      }
      case "checkout": {
        const status = await this.status(signal);
        const branch = status.refs.find(
          (branch) => branch.name === params.branch && !branch.remote,
        );
        if (!branch)
          throw new RpcError("NOT_FOUND", "Local branch does not exist");
        await this.run(["switch", "--", branch.name], signal);
        break;
      }
      case "branchCreate": {
        const name = await this.branchName(params.name, signal);
        const base = params.startPoint
          ? await this.commitId(params.startPoint, signal)
          : undefined;
        await this.run(["switch", "-c", name, ...(base ? [base] : [])], signal);
        break;
      }
      case "branchTrack": {
        const branch = (await this.status(signal)).refs.find(
          (branch) => branch.ref === params.ref && branch.remote,
        );
        if (!branch)
          throw new RpcError("NOT_FOUND", "Remote branch does not exist");
        const name = await this.branchName(params.name, signal);
        await this.run(["switch", "--track", "-c", name, branch.ref], signal);
        break;
      }
      case "branchRename": {
        const old = await this.branchName(params.branch, signal),
          name = await this.branchName(params.name, signal);
        await this.run(["branch", "-m", old, name], signal);
        break;
      }
      case "branchDelete": {
        if (params.confirm !== true)
          throw new RpcError(
            "CONFIRM_REQUIRED",
            "Confirm deleting the local branch",
          );
        const name = await this.branchName(params.branch, signal);
        await this.run(["branch", "-d", "--", name], signal);
        break;
      }
      case "merge": {
        const id = await this.commitId(params.ref, signal);
        if ((await this.status(signal)).changes.length)
          throw new RpcError(
            "DIRTY_WORKTREE",
            "Commit or stash disk changes before merging",
          );
        await this.run(
          ["merge", "--no-edit", id],
          signal,
          this.files.root,
          progress,
        );
        break;
      }
      case "continue":
      case "abort": {
        const status = await this.status(signal);
        if (!status.operation || status.operation !== params.operation)
          throw new RpcError(
            "STALE_STATE",
            "The repository operation changed. Refresh before continuing.",
          );
        if (method === "abort" && params.confirm !== true)
          throw new RpcError(
            "CONFIRM_REQUIRED",
            "Confirm aborting the operation",
          );
        if (
          method === "continue" &&
          status.changes.some((change) => change.conflict)
        )
          throw new RpcError(
            "CONFLICT",
            "Resolve and stage all conflicted files first",
          );
        await this.run(
          [status.operation, `--${method}`],
          signal,
          this.files.root,
          progress,
        );
        break;
      }
      case "cherryPick":
      case "revert": {
        if (params.confirm !== true)
          throw new RpcError(
            "CONFIRM_REQUIRED",
            "Confirm applying this commit to the current branch",
          );
        const id = await this.commitId(params.ref, signal);
        const status = await this.status(signal);
        if (status.changes.length || status.operation)
          throw new RpcError(
            "DIRTY_WORKTREE",
            "Commit or stash disk changes and finish the current operation first",
          );
        await this.run(
          [method === "cherryPick" ? "cherry-pick" : "revert", "--no-edit", id],
          signal,
          this.files.root,
          progress,
        );
        break;
      }
      case "stashSave": {
        if (typeof params.message !== "string" || !params.message.trim())
          throw new RpcError("INVALID_PARAMS", "A stash message is required");
        const status = await this.status(signal);
        if (
          status.operation ||
          status.changes.some((change) => change.conflict)
        )
          throw new RpcError(
            "CONFLICT",
            "Finish the current operation before stashing",
          );
        await this.run(
          [
            "stash",
            "push",
            ...(params.includeUntracked === true
              ? ["--include-untracked"]
              : []),
            "--message",
            params.message,
            "--",
            ".",
          ],
          signal,
        );
        break;
      }
      case "stashApply":
      case "stashPop":
      case "stashDrop": {
        const stash = await this.stash(params, signal);
        if (method === "stashDrop") {
          if (params.confirm !== true)
            throw new RpcError(
              "CONFIRM_REQUIRED",
              "Confirm deleting this stash",
            );
          await this.run(["stash", "drop", stash.ref], signal);
        } else {
          if ((await this.status(signal)).changes.length)
            throw new RpcError(
              "DIRTY_WORKTREE",
              "Commit or stash disk changes before restoring a stash",
            );
          await this.run(
            [
              "stash",
              method === "stashPop" ? "pop" : "apply",
              "--index",
              stash.ref,
            ],
            signal,
          );
        }
        break;
      }
      case "remoteAdd": {
        if (
          typeof params.name !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(params.name)
        )
          throw new RpcError(
            "INVALID_PARAMS",
            "Enter a remote name using letters, numbers, dots, hyphens, or underscores",
          );
        this.remoteUrl(params.url);
        await this.run(
          ["remote", "add", params.name, String(params.url)],
          signal,
        );
        break;
      }
      case "remoteRemove": {
        if (params.confirm !== true)
          throw new RpcError("CONFIRM_REQUIRED", "Confirm removing the remote");
        const remote = await this.remote(params.remote, signal);
        await this.run(["remote", "remove", remote], signal);
        break;
      }
      case "push": {
        const status = await this.status(signal);
        if (!status.upstream)
          throw new RpcError(
            "NO_UPSTREAM",
            "Publish this branch to a remote first",
          );
        const remote = (
          await this.run(
            ["config", "--get", `branch.${status.branch}.remote`],
            signal,
          )
        ).stdout.trim();
        const target = (
          await this.run(
            ["config", "--get", `branch.${status.branch}.merge`],
            signal,
          )
        ).stdout.trim();
        if (remote.startsWith("-") || !target.startsWith("refs/heads/"))
          throw new RpcError("INVALID_PARAMS", "Invalid branch upstream");
        await this.run(
          ["push", "--progress", remote, `HEAD:${target}`],
          signal,
          this.files.root,
          progress,
        );
        break;
      }
      case "publish": {
        const remote = await this.remote(params.remote, signal),
          status = await this.status(signal);
        if (!status.head || !status.branches.includes(status.branch))
          throw new RpcError(
            "INVALID_PARAMS",
            "Create a commit on a local branch before publishing",
          );
        await this.run(
          [
            "push",
            "--progress",
            "--set-upstream",
            remote,
            `refs/heads/${status.branch}:refs/heads/${status.branch}`,
          ],
          signal,
          this.files.root,
          progress,
        );
        break;
      }
      case "pull": {
        const status = await this.status(signal);
        if (!status.upstream)
          throw new RpcError(
            "NO_UPSTREAM",
            "Publish or track a remote branch before pulling",
          );
        if (status.changes.length || status.operation)
          throw new RpcError(
            "DIRTY_WORKTREE",
            "Commit or stash disk changes before pulling",
          );
        await this.run(
          ["pull", params.rebase === true ? "--rebase" : "--ff-only", "--progress"],
          signal,
          this.files.root,
          progress,
        );
        break;
      }
      case "fetch":
        await this.run(
          ["fetch", "--all", "--prune", "--progress"],
          signal,
          this.files.root,
          progress,
        );
        break;
      case "clone": {
        if (
          typeof params.url !== "string" ||
          !params.url ||
          params.url.startsWith("-") ||
          !/^https?:\/\/|^ssh:\/\/|^[\w.-]+@[\w.-]+:|^file:\/\//.test(
            params.url,
          )
        )
          throw new RpcError(
            "INVALID_PARAMS",
            "Use an HTTPS, SSH, or file clone URL",
          );
        if (typeof params.destination !== "string" || !params.destination)
          throw new RpcError("INVALID_PARAMS", "Clone destination is required");
        const destination = await this.files.resolve(params.destination, true);
        try {
          await fs.lstat(destination);
          throw new RpcError("EXISTS", "Clone destination already exists");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        try {
          await fs.mkdir(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new RpcError("EXISTS", "Clone destination already exists");
          throw error;
        }
        try {
          await this.run(
            ["clone", "--progress", "--", params.url, destination],
            signal,
            this.files.root,
            progress,
          );
        } catch (error) {
          await fs.rm(destination, { recursive: true, force: true });
          throw error;
        }
        return { path: params.destination };
      }
      default:
        throw new RpcError("METHOD_NOT_FOUND", "Unknown Git operation");
    }
    return { ok: true };
  }
}
