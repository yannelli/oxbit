import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK = fileURLToPath(new URL("../../scripts/agent/hooks/run.mjs", import.meta.url));

export type HookResult = { status: number | null; stdout: string; stderr: string };

export function runHook(tool: string, event: string, input: unknown, env: NodeJS.ProcessEnv = process.env): HookResult {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const result = spawnSync("node", [HOOK, tool, event], { input: stdin, encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=hook-test", "-c", "user.email=hook@test", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  });
}

export function pushedRepo(root: string): string {
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { env: GIT_ENV });
  execFileSync("git", ["init", "-b", "main", work], { env: GIT_ENV });
  fs.writeFileSync(path.join(work, "a.txt"), "a\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-m", "first");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-u", "origin", "main");
  return work;
}
