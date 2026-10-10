import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import type {
  ACPCheckpoint,
  ACPCheckpointChange,
  ACPCheckpointDiff,
  ACPCheckpointRestore,
  ACPCheckpointUnavailable,
} from "@oxbit/sdk";
import { MAX_MESSAGE_BYTES, RpcError } from "@oxbit/protocol";
import { runCommand } from "./processes.js";

export const CHECKPOINT_TIMEOUT = 5000;
const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GITLINK = "160000";
const BATCH = 500;
const unavailable = (reason: ACPCheckpointUnavailable["unavailable"]): ACPCheckpointUnavailable => ({ unavailable: reason });

/** Workspace snapshots as git trees built in a temporary index. Writes objects only: no refs, HEAD, or real index. */
export class ACPCheckpoints {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private root: string,
    private executable = "git",
  ) {}
  private async run(args: string[], signal?: AbortSignal, index?: string, acceptFailure = false) {
    const result = await runCommand(this.executable, ["--literal-pathspecs", "-c", "color.ui=false", ...args], {
      cwd: this.root,
      signal,
      maxBytes: MAX_MESSAGE_BYTES,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
        ...(index ? { GIT_INDEX_FILE: index } : {}),
      },
    });
    if (result.exitCode && !acceptFailure)
      throw new RpcError("GIT_FAILED", result.stderr.trim() || `Git exited ${result.exitCode}`, { exitCode: result.exitCode });
    return result;
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }
  private async withIndex<T>(task: (index: string) => Promise<T>) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-checkpoint-"));
    try {
      return await task(path.join(directory, "index"));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  /** Copies the real index so `add -A` reuses its stat data, then writes the tree. */
  private async snapshot(signal?: AbortSignal): Promise<string | ACPCheckpointUnavailable> {
    const repository = await this.run(["rev-parse", "--git-dir", "--show-toplevel"], signal, undefined, true);
    if (repository.exitCode) return unavailable("not-repository");
    const top = repository.stdout.trim().split("\n").at(-1) ?? "";
    if ((await fs.realpath(top).catch(() => top)) !== this.root) return unavailable("subdirectory");
    const real = path.resolve(this.root, (await this.run(["rev-parse", "--git-path", "index"], signal)).stdout.trim());
    return this.withIndex(async (index) => {
      await fs.copyFile(real, index).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await this.run(["add", "-A"], signal, index);
      return (await this.run(["write-tree"], signal, index)).stdout.trim();
    });
  }
  create(signal?: AbortSignal): Promise<ACPCheckpoint> {
    const timeout = AbortSignal.timeout(CHECKPOINT_TIMEOUT);
    return this.serial(async () => {
      try {
        const tree = await this.snapshot(signal ? AbortSignal.any([signal, timeout]) : timeout);
        return typeof tree === "string" ? { tree } : tree;
      } catch (error) {
        if (signal?.aborted) throw error;
        return unavailable(timeout.aborted ? "timeout" : "failed");
      }
    });
  }
  private async changes(tree: unknown, signal?: AbortSignal): Promise<ACPCheckpointDiff> {
    if (typeof tree !== "string" || !TREE.test(tree)) throw new RpcError("INVALID_PARAMS", "Choose a valid checkpoint");
    const current = await this.snapshot(signal);
    if (typeof current !== "string") return current;
    if ((await this.run(["cat-file", "-e", `${tree}^{tree}`], signal, undefined, true)).exitCode) return unavailable("missing");
    const output = (await this.run(["diff-tree", "-r", "-z", "--raw", "--no-renames", current, tree], signal)).stdout.split("\0");
    const changes: ACPCheckpointChange[] = [];
    for (let i = 0; i + 1 < output.length; i += 2) {
      const [from, to, , , status] = output[i]!.replace(/^:/, "").split(" ");
      if (from === GITLINK || to === GITLINK) continue;
      changes.push({ status: status as ACPCheckpointChange["status"], path: output[i + 1]! });
    }
    return { tree: current, changes };
  }
  diff(tree: unknown, signal?: AbortSignal): Promise<ACPCheckpointDiff> {
    return this.serial(() => this.changes(tree, signal));
  }
  /** Writes only paths that differ from the checkpoint. `paths` is the set the client checked for unsaved edits. */
  restore(tree: unknown, paths: unknown, signal?: AbortSignal): Promise<ACPCheckpointRestore> {
    if (paths !== undefined && (!Array.isArray(paths) || paths.some((item) => typeof item !== "string")))
      throw new RpcError("INVALID_PARAMS", "paths must be a string array");
    return this.serial(async () => {
      const diff = await this.changes(tree, signal);
      if ("unavailable" in diff) throw new RpcError("CHECKPOINT_UNAVAILABLE", "This checkpoint is no longer available");
      const checked = paths && new Set(paths as string[]);
      if (checked && diff.changes.some((change) => !checked.has(change.path)))
        throw new RpcError("CONFLICT", "Files changed while preparing the restore. Try again.");
      const deleted = diff.changes.filter((change) => change.status === "D").map((change) => change.path);
      const restored = diff.changes.filter((change) => change.status !== "D").map((change) => change.path);
      for (const file of deleted) await this.remove(file);
      if (restored.length)
        await this.withIndex(async (index) => {
          await this.run(["read-tree", tree as string], signal, index);
          for (let i = 0; i < restored.length; i += BATCH)
            await this.run(["checkout-index", "-f", "--", ...restored.slice(i, i + BATCH)], signal, index);
        });
      return { restored, deleted };
    });
  }
  private async remove(relative: string) {
    const full = path.resolve(this.root, relative);
    if (!full.startsWith(this.root + path.sep)) throw new RpcError("PATH_DENIED", `Path is outside the workspace: ${relative}`);
    await fs.rm(full, { force: true });
    for (let directory = path.dirname(full); directory !== this.root; directory = path.dirname(directory))
      if (!(await fs.rmdir(directory).then(() => true, () => false))) break;
  }
}
