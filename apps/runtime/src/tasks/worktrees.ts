import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { RpcError } from "@oxbit/protocol";
import type { TaskHooks, TaskPhase, TaskWorktree } from "@oxbit/sdk";
import { runCommand } from "../processes.js";
import {
  atomicWrite,
  fileLock,
  readOptional,
  type TaskConfigStore,
} from "./config.js";
import type { TaskRunner } from "./runner.js";
interface Record extends TaskWorktree {
  hooks: TaskHooks;
  env: { [key: string]: string };
  sourceDir: string;
  operationPid?: number;
}
export class TaskWorktrees {
  private file: string;
  constructor(
    private store: TaskConfigStore,
    private runner: TaskRunner,
  ) {
    this.file = path.join(store.projectHome, "worktrees.json");
  }
  private async records(): Promise<Record[]> {
    const text = await readOptional(this.file);
    if (!text) return [];
    const records = JSON.parse(text);
    if (!Array.isArray(records))
      throw new RpcError("INVALID_STATE", "Invalid worktree registry");
    for (const record of records as Record[]) {
      this.validate(record);
      if (!["creating", "removing"].includes(record.state)) continue;
      let active = false;
      if (
        Number.isSafeInteger(record.operationPid) &&
        record.operationPid! > 0
      ) {
        try {
          process.kill(record.operationPid!, 0);
          active = true;
        } catch (error) {
          active = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      if (!active) {
        record.state =
          record.state === "creating"
            ? "init-failed"
            : (await fs.stat(record.path).catch(() => null))
              ? "ready"
              : "teardown-failed";
        record.message =
          "Worktree operation was interrupted. Inspect its files and retry the remaining phase explicitly.";
      }
    }
    return records;
  }
  private async persist(records: Record[]) {
    const text = await readOptional(this.file);
    await atomicWrite(
      this.file,
      JSON.stringify(records, null, 2),
      text === null ? null : createHash("sha256").update(text).digest("hex"),
    );
  }
  async list(): Promise<TaskWorktree[]> {
    return (await this.records())
      .filter((item) => item.state !== "removed")
      .map(
        ({
          hooks: _hooks,
          env: _env,
          sourceDir: _source,
          operationPid: _pid,
          ...item
        }) => item,
      );
  }
  private async git(
    args: string[],
    cwd = this.store.root,
    signal?: AbortSignal,
  ) {
    const result = await runCommand(this.store.gitPath, args, {
      cwd,
      signal,
      maxBytes: 1048576,
    });
    if (result.exitCode !== 0)
      throw new RpcError(
        "GIT_FAILED",
        result.stderr.trim() ||
          result.stdout.trim() ||
          "Git worktree operation failed",
      );
    return result.stdout;
  }
  private async phase(
    record: Record,
    phase: TaskPhase,
    owner: string,
    signal?: AbortSignal,
  ) {
    const script = record.hooks[phase];
    if (!script || (Array.isArray(script) && !script.length)) return;
    const command = Array.isArray(script) ? script.join("\n") : script;
    if (!command.trim()) return;
    const cwd =
      phase === "preinit" || phase === "teardown"
        ? record.preinitDir
        : record.path;
    await this.runner.runHook(
      owner,
      `set -e\n${command}`,
      `Worktree ${record.branch} · ${phase}`,
      {
        root: cwd,
        projectDir: record.path,
        sourceDir: record.sourceDir,
        preinitDir: record.preinitDir,
        branch: record.branch,
      },
      record.env,
      signal,
    );
  }
  async create(
    owner: string,
    branch: string,
    base = "HEAD",
    signal?: AbortSignal,
  ) {
    if (
      !branch ||
      branch.startsWith("-") ||
      /[\x00-\x20]/.test(branch) ||
      branch.length > 200 ||
      !base ||
      base.startsWith("-") ||
      /[\x00-\x20]/.test(base)
    )
      throw new RpcError(
        "INVALID_PARAMS",
        "Provide a valid branch name and base revision",
      );
    return fileLock(
      path.join(this.store.projectHome, "worktree-operation"),
      async () => {
        await this.git(
          ["check-ref-format", "--branch", branch],
          undefined,
          signal,
        );
        await this.git(
          ["rev-parse", "--verify", `${base}^{commit}`],
          undefined,
          signal,
        );
        const catalog = await this.store.catalog(),
          records = await this.records(),
          id = randomUUID();
        const record: Record = {
          id,
          path: path.join(this.store.projectHome, "worktrees", id),
          branch,
          preinitDir: path.join(this.store.projectHome, "preinit", id),
          state: "creating",
          operationPid: process.pid,
          hooks: catalog.worktree,
          env: catalog.env,
          sourceDir: this.store.root,
        };
        records.push(record);
        await this.persist(records);
        await fs.mkdir(record.preinitDir, { recursive: true, mode: 0o700 });
        await fs.mkdir(path.dirname(record.path), {
          recursive: true,
          mode: 0o700,
        });
        try {
          await this.phase(record, "preinit", owner, signal);
          if (signal?.aborted)
            throw new RpcError("CANCELLED", "Worktree creation cancelled");
          await this.git(
            ["worktree", "add", "-b", branch, "--", record.path, base],
            undefined,
            signal,
          );
          await this.phase(record, "init", owner, signal);
          record.state = "ready";
          await this.persist(records);
          return record;
        } catch (error) {
          record.state = "init-failed";
          record.message = (error as Error).message;
          await this.persist(records);
          throw new RpcError(
            "WORKTREE_FAILED",
            `${record.message}. The worktree record is retained for inspection/retry.`,
            { worktree: record },
          );
        }
      },
    );
  }
  private validate(record: Record) {
    if (
      !/^[0-9a-f-]{36}$/.test(record.id) ||
      record.path !==
        path.join(this.store.projectHome, "worktrees", record.id) ||
      record.preinitDir !==
        path.join(this.store.projectHome, "preinit", record.id)
    )
      throw new RpcError(
        "INVALID_STATE",
        "Worktree registry contains an unowned path",
      );
  }
  async retryInit(owner: string, id: string, signal?: AbortSignal) {
    return fileLock(
      path.join(this.store.projectHome, "worktree-operation"),
      async () => {
        const records = await this.records(),
          record = records.find((item) => item.id === id);
        if (!record || record.state !== "init-failed")
          throw new RpcError(
            "INVALID_STATE",
            "Only a failed initialization can be retried",
          );
        this.validate(record);
        const real = await fs.realpath(record.path).catch(() => "");
        if (real !== record.path)
          throw new RpcError(
            "INVALID_STATE",
            "Checkout was not created. Remove this record and create a new worktree.",
          );
        try {
          await this.phase(record, "init", owner, signal);
          record.state = "ready";
          record.message = undefined;
        } catch (error) {
          record.message = (error as Error).message;
          throw error;
        } finally {
          await this.persist(records);
        }
        return record;
      },
    );
  }
  async remove(owner: string, id: string, signal?: AbortSignal) {
    return fileLock(
      path.join(this.store.projectHome, "worktree-operation"),
      async () => {
        const records = await this.records(),
          record = records.find((item) => item.id === id);
        if (!record || record.state === "removed")
          throw new RpcError("NOT_FOUND", "Managed worktree was not found");
        this.validate(record);
        if (path.resolve(record.path) === this.store.root)
          throw new RpcError(
            "INVALID_STATE",
            "Switch to the source checkout before removing this worktree",
          );
        const exists = await fs.lstat(record.path).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (
          exists &&
          (exists.isSymbolicLink() ||
            (await fs.realpath(record.path)) !== record.path)
        )
          throw new RpcError("INVALID_STATE", "Managed worktree path changed");
        if (exists) {
          const known = await this.git(
            ["worktree", "list", "--porcelain", "-z"],
            undefined,
            signal,
          );
          if (!known.split("\0").includes(`worktree ${record.path}`))
            throw new RpcError(
              "INVALID_STATE",
              "Directory is no longer a registered worktree; it will not be removed",
            );
          const status = await this.git(
            ["status", "--porcelain", "--untracked-files=all"],
            record.path,
            signal,
          );
          if (status.trim())
            throw new RpcError(
              "WORKTREE_DIRTY",
              "Worktree has uncommitted or untracked files. Save them before removal.",
            );
        }
        const previousState = record.state;
        record.state = "removing";
        record.operationPid = process.pid;
        record.message = undefined;
        await this.persist(records);
        let removed = !exists;
        try {
          if (exists) {
            await this.phase(record, "preteardown", owner, signal);
            await this.runner.stopInDirectory(record.path);
            if (signal?.aborted)
              throw new RpcError("CANCELLED", "Worktree removal cancelled");
            await this.git(
              ["worktree", "remove", "--", record.path],
              undefined,
              signal,
            );
            removed = true;
          }
          await this.phase(record, "teardown", owner, signal);
          record.state = "removed";
          await this.persist(records);
          await fs.rm(record.preinitDir, { recursive: true, force: true });
          return { id, removed: true };
        } catch (error) {
          record.state = removed
            ? "teardown-failed"
            : previousState === "init-failed"
              ? "init-failed"
              : "ready";
          record.message = (error as Error).message;
          await this.persist(records);
          throw error;
        }
      },
    );
  }
}
