import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Git } from "../src/git.js";
import { WorkspaceFiles } from "../src/filesystem.js";
import { runCommand } from "../src/processes.js";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Oxbit Test",
  GIT_AUTHOR_EMAIL: "oxbit@example.test",
  GIT_COMMITTER_NAME: "Oxbit Test",
  GIT_COMMITTER_EMAIL: "oxbit@example.test",
});
const directories: string[] = [];
afterEach(async () => {
  for (const root of directories.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function command(cwd: string, args: string[]) {
  const result = await runCommand("git", args, { cwd });
  if (result.exitCode) throw new Error(result.stderr + result.stdout);
  return result.stdout.trim();
}
async function setup(seed = true) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-git-index-")),
  );
  directories.push(root);
  const git = new Git(new WorkspaceFiles(root)),
    signal = new AbortController().signal;
  const act = (method: string, params: Record<string, unknown> = {}) =>
    git.action(method, params, signal, () => {});
  const write = (name: string, text: string) =>
    fs.writeFile(path.join(root, name), text);
  await command(root, ["init", "--initial-branch=main"]);
  if (seed) {
    await write("keep.txt", "a\nb\n");
    await write("old.txt", "x\n");
    await act("stageAll");
    await act("commit", { message: "Initial" });
  }
  return { root, git, act, write };
}
const short = (root: string) => command(root, ["status", "--porcelain=v1"]);

describe("index snapshot and restore", () => {
  it("restores partial hunks, renames and added files for the given paths", async () => {
    const { root, act, write } = await setup();
    await write("keep.txt", "a2\nb\n");
    await act("stage", { path: "keep.txt" });
    await write("keep.txt", "a2\nb2\n");
    await command(root, ["mv", "old.txt", "new.txt"]);
    await write("added.txt", "n\n");
    await act("stage", { path: "added.txt" });
    const before = await short(root);
    const { tree } = (await act("indexSnapshot")) as { tree: string };
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
    await act("unstageAll");
    expect(await short(root)).not.toBe(before);
    await act("indexRestore", {
      tree,
      paths: ["keep.txt", "new.txt", "old.txt", "added.txt", "missing.txt"],
    });
    expect(await short(root)).toBe(before);
    expect(await command(root, ["diff", "--cached", "--", "keep.txt"])).toContain("+a2");
    expect(await command(root, ["diff", "--", "keep.txt"])).toContain("+b2");
  });

  it("restores only the listed paths", async () => {
    const { root, act, write } = await setup();
    await write("keep.txt", "staged\n");
    await write("other.txt", "o\n");
    await act("stageAll");
    const { tree } = (await act("indexSnapshot")) as { tree: string };
    await act("unstageAll");
    await act("indexRestore", { tree, paths: ["keep.txt"] });
    expect(await command(root, ["diff", "--cached", "--name-only"])).toBe("keep.txt");
  });

  it("works on an unborn branch", async () => {
    const { root, act, write } = await setup(false);
    await write("a.txt", "a\n");
    await write("b.txt", "b\n");
    await act("stage", { path: "a.txt" });
    const { tree } = (await act("indexSnapshot")) as { tree: string };
    await act("stage", { path: "b.txt" });
    await act("indexRestore", { tree, paths: ["a.txt", "b.txt"] });
    expect(await command(root, ["diff", "--cached", "--name-only"])).toBe("a.txt");
  });

  it("rejects invalid trees and paths", async () => {
    const { act } = await setup();
    const { tree } = (await act("indexSnapshot")) as { tree: string };
    await expect(act("indexRestore", { tree: "--hard", paths: ["keep.txt"] })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
    await expect(act("indexRestore", { tree: "0".repeat(40), paths: ["keep.txt"] })).rejects.toMatchObject({
      code: "GIT_FAILED",
    });
    await expect(act("indexRestore", { tree, paths: ["../outside"] })).rejects.toMatchObject({
      code: "PATH_DENIED",
    });
    await expect(act("indexRestore", { tree, paths: "keep.txt" })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
  });
});

describe("log base range", () => {
  it("lists only commits on the branch after the base", async () => {
    const { root, git, act, write } = await setup();
    await act("branchCreate", { name: "feature" });
    await write("feature.txt", "f\n");
    await act("stageAll");
    await act("commit", { message: "Feature work" });
    await act("checkout", { branch: "main" });
    for (let i = 0; i < 101; i++)
      await command(root, ["commit", "--allow-empty", "-q", "-m", `Main ${i}`]);
    await act("checkout", { branch: "feature" });
    const range = await git.log({ base: "main", limit: 50 });
    expect(range.commits.map((commit) => commit.subject)).toEqual(["Feature work"]);
    expect(range.hasMore).toBe(false);
    await expect(git.log({ base: "--all" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  }, 90_000);
});
