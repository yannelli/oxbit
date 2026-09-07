import path from "node:path";
import * as fs from "node:fs/promises";
import { RpcError } from "@oxbit/protocol";
import { runCommand } from "./processes.js";
import { WorkspaceFiles } from "./filesystem.js";
export class Git {
  constructor(private files: WorkspaceFiles) {}
  private async run(
    args: string[],
    signal?: AbortSignal,
    cwd = this.files.root,
    onData?: (data: string) => void,
    acceptFailure = false,
  ) {
    const result = await runCommand("git", args, {
      cwd,
      signal,
      onData,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
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
  async status(signal?: AbortSignal) {
    const status = await this.run(["status", "--porcelain=v1", "--untracked-files=all", "-z"], signal);
    const branch = await this.run(
      ["symbolic-ref", "--short", "HEAD"],
      signal,
      this.files.root,
      undefined,
      true,
    );
    const branches = await this.run(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      signal,
    );
    const changes = [];
    const records = status.stdout.split("\0");
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      if (!row) continue;
      changes.push({ path: row.slice(3), index: row[0], working: row[1] });
      if (row[0] === "R" || row[0] === "C" || row[1] === "R" || row[1] === "C")
        i++;
    }
    return {
      branch: branch.stdout.trim() || "(detached)",
      branches: branches.stdout.trim().split("\n").filter(Boolean),
      changes,
    };
  }
  async diff(relative: string, staged = false, signal?: AbortSignal) {
    await this.files.resolve(relative, true);
    const diff = await this.run(
      ["diff", ...(staged ? ["--cached"] : []), "--", relative],
      signal,
    );
    const before = await this.run(
      ["show", staged ? `HEAD:${relative}` : `:${relative}`],
      signal,
      this.files.root,
      undefined,
      true,
    );
    let after = "";
    if (staged)
      after = (
        await this.run(
          ["show", `:${relative}`],
          signal,
          this.files.root,
          undefined,
          true,
        )
      ).stdout;
    else
      try {
        after = (await this.files.read(relative)).text;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    return {
      before: before.exitCode ? "" : before.stdout,
      after,
      diff: diff.stdout,
    };
  }
  async action(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    progress: (data: string) => void,
  ) {
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
        await this.run(["add", "--", relative], signal);
        break;
      case "unstage": {
        const head = await this.run(
          ["rev-parse", "--verify", "HEAD"],
          signal,
          this.files.root,
          undefined,
          true,
        );
        await this.run(
          head.exitCode
            ? ["rm", "--cached", "--", relative]
            : ["reset", "HEAD", "--", relative],
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
      case "checkout": {
        if (typeof params.branch !== "string" || params.branch.startsWith("-"))
          throw new RpcError("INVALID_PARAMS", "Existing branch is required");
        const branches = (await this.status(signal)).branches;
        if (!branches.includes(params.branch))
          throw new RpcError("NOT_FOUND", "Branch does not exist");
        await this.run(["checkout", params.branch, "--"], signal);
        break;
      }
      case "push":
        await this.run(
          ["push", "--progress"],
          signal,
          this.files.root,
          progress,
        );
        break;
      case "fetch":
        await this.run(
          ["fetch", "--prune", "--progress"],
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
        try { await fs.mkdir(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RpcError("EXISTS", "Clone destination already exists"); throw error; }
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
