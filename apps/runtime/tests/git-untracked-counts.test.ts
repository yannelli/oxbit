import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Git } from "../src/git.js";
import { WorkspaceFiles } from "../src/filesystem.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
const hasMkfifo = (() => {
  if (process.platform === "win32") return false;
  try {
    execFileSync("sh", ["-c", "command -v mkfifo"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
async function setup() {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-git-counts-")),
  );
  directories.push(directory);
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
  return { directory, root, git: new Git(new WorkspaceFiles(root)) };
}
/** Fails the test instead of hanging when status blocks on a special file. */
async function statusWithin(git: Git, ms = 3000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      git.status(new AbortController().signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`git.status did not finish in ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const change = (status: Awaited<ReturnType<Git["status"]>>, file: string) =>
  status.changes.find((entry) => entry.path === file);

describe("untracked line counts", () => {
  it.skipIf(!hasMkfifo)("skips an untracked FIFO without opening it", async () => {
    const { root, git } = await setup();
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    await fs.writeFile(path.join(root, "note.txt"), "one\ntwo\n");
    const status = await statusWithin(git);
    expect(change(status, "pipe")?.unstaged).toBeUndefined();
    expect(change(status, "note.txt")?.unstaged).toEqual({ added: 2, removed: 0 });
  });

  it.skipIf(!hasMkfifo)("skips a symbolic link to a FIFO, also across concurrent status calls", async () => {
    const { directory, root, git } = await setup();
    const fifo = path.join(directory, "outside.fifo");
    execFileSync("mkfifo", [fifo]);
    await fs.symlink(fifo, path.join(root, "link"));
    const results = await Promise.all([1, 2, 3, 4].map(() => statusWithin(git)));
    for (const status of results) expect(change(status, "link")?.unstaged).toBeUndefined();
    await expect(fs.readFile(path.join(root, ".git", "HEAD"), "utf8")).resolves.toContain("ref:");
  });

  it("does not report the line count of a link target outside the workspace", async () => {
    const { directory, root, git } = await setup();
    const target = path.join(directory, "outside.txt");
    await fs.writeFile(target, "a\nb\nc\nd\n");
    await fs.symlink(target, path.join(root, "outside-link"));
    await fs.writeFile(path.join(root, "inside.txt"), "a\nb\n");
    await fs.symlink("inside.txt", path.join(root, "inside-link"));
    const status = await statusWithin(git);
    expect(change(status, "outside-link")).toMatchObject({ index: "?" });
    expect(change(status, "outside-link")?.unstaged).toBeUndefined();
    expect(change(status, "inside-link")?.unstaged).toBeUndefined();
    expect(change(status, "inside.txt")?.unstaged).toEqual({ added: 2, removed: 0 });
  });
});
