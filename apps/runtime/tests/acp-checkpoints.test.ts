import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ACPCheckpoints } from "../src/acp-checkpoints.js";
import { runCommand } from "../src/processes.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
async function git(cwd: string, args: string[]) {
  const result = await runCommand("git", ["-c", "user.name=Oxbit Test", "-c", "user.email=oxbit@example.test", ...args], { cwd });
  if (result.exitCode) throw new Error(result.stderr + result.stdout);
  return result.stdout.trim();
}
async function workspace(init = true) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-checkpoints-")));
  directories.push(directory);
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  const write = async (name: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  };
  const read = (name: string) => fs.readFile(path.join(root, name), "utf8").catch(() => undefined);
  if (init) {
    await git(root, ["init", "--initial-branch=main"]);
    await write(".gitignore", "ignored.log\n");
    await write("tracked.txt", "original\n");
    await write("removed.txt", "keep me\n");
    await write("nested/deep.txt", "deep\n");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "base"]);
  }
  return { root, write, read, checkpoints: new ACPCheckpoints(root) };
}
const tree = async (checkpoints: ACPCheckpoints) => {
  const result = await checkpoints.create();
  if (!("tree" in result)) throw new Error(`Checkpoint unavailable: ${result.unavailable}`);
  return result.tree;
};

describe("ACP checkpoints", () => {
  it("restores modified, added, and deleted files and leaves ignored files, the index, and HEAD alone", async () => {
    const { root, write, read, checkpoints } = await workspace();
    await write("staged.txt", "staged\n");
    await git(root, ["add", "staged.txt"]);
    const indexPath = path.resolve(root, await git(root, ["rev-parse", "--git-path", "index"]));
    const index = await fs.readFile(indexPath);
    const head = await git(root, ["rev-parse", "HEAD"]);
    const refs = await git(root, ["for-each-ref"]);
    const before = await tree(checkpoints);
    await write("tracked.txt", "agent edit\n");
    await write("untracked.txt", "new file\n");
    await write("nested/added/file.txt", "new nested\n");
    await fs.rm(path.join(root, "removed.txt"));
    await write("ignored.log", "ignored after\n");
    expect(Buffer.compare(await fs.readFile(indexPath), index)).toBe(0);
    const diff = await checkpoints.diff(before);
    if ("unavailable" in diff) throw new Error(diff.unavailable);
    expect(diff.changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { status: "D", path: "nested/added/file.txt" },
      { status: "A", path: "removed.txt" },
      { status: "M", path: "tracked.txt" },
      { status: "D", path: "untracked.txt" },
    ]);
    const result = await checkpoints.restore(before, diff.changes.map((change) => change.path));
    expect(result.restored.sort()).toEqual(["removed.txt", "tracked.txt"]);
    expect(result.deleted.sort()).toEqual(["nested/added/file.txt", "untracked.txt"]);
    expect(await read("tracked.txt")).toBe("original\n");
    expect(await read("removed.txt")).toBe("keep me\n");
    expect(await read("staged.txt")).toBe("staged\n");
    expect(await read("untracked.txt")).toBeUndefined();
    await expect(fs.stat(path.join(root, "nested/added"))).rejects.toThrow();
    expect(await read("nested/deep.txt")).toBe("deep\n");
    expect(await read("ignored.log")).toBe("ignored after\n");
    expect(Buffer.compare(await fs.readFile(indexPath), index)).toBe(0);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(root, ["for-each-ref"])).toBe(refs);
    expect(await git(root, ["stash", "list"])).toBe("");
    expect(await tree(checkpoints)).toBe(before);
    const empty = await checkpoints.diff(before);
    expect("changes" in empty && empty.changes).toEqual([]);
  });
  it("refuses a restore when files changed outside the checked paths", async () => {
    const { write, read, checkpoints } = await workspace();
    const before = await tree(checkpoints);
    await write("tracked.txt", "agent edit\n");
    await write("late.txt", "late\n");
    await expect(checkpoints.restore(before, ["tracked.txt"])).rejects.toThrow("Files changed");
    expect(await read("tracked.txt")).toBe("agent edit\n");
    expect(await read("late.txt")).toBe("late\n");
  });
  it("works in a linked worktree, whose .git is a file", async () => {
    const { root, checkpoints: main } = await workspace();
    const linked = path.join(path.dirname(root), "linked");
    await git(root, ["worktree", "add", "-b", "linked", linked]);
    expect((await fs.stat(path.join(linked, ".git"))).isFile()).toBe(true);
    const checkpoints = new ACPCheckpoints(linked);
    const before = await tree(checkpoints);
    await fs.writeFile(path.join(linked, "tracked.txt"), "linked edit\n");
    await checkpoints.restore(before, ["tracked.txt"]);
    expect(await fs.readFile(path.join(linked, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await tree(main)).toBe(before);
  });
  it("reports unavailable outside a repository, in a subdirectory, and for unknown trees", async () => {
    const plain = await workspace(false);
    expect(await plain.checkpoints.create()).toEqual({ unavailable: "not-repository" });
    const { root, checkpoints } = await workspace();
    expect(await new ACPCheckpoints(path.join(root, "nested")).create()).toEqual({ unavailable: "subdirectory" });
    expect(await checkpoints.diff("0".repeat(40))).toEqual({ unavailable: "missing" });
    await expect(checkpoints.diff("HEAD")).rejects.toThrow("valid checkpoint");
  });
});
