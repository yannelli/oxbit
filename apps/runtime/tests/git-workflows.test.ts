import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Git } from "../src/git.js";
import { WorkspaceFiles } from "../src/filesystem.js";
import { runCommand } from "../src/processes.js";

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
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-git-workflows-")),
  );
  directories.push(directory);
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  const git = new Git(new WorkspaceFiles(root)),
    signal = new AbortController().signal;
  const act = (method: string, params: Record<string, unknown> = {}) =>
    git.action(method, params, signal, () => {});
  await command(root, ["init", "--initial-branch=main"]);
  await command(root, ["config", "user.name", "Oxbit Test"]);
  await command(root, ["config", "user.email", "oxbit@example.test"]);
  const write = (name: string, text: string) =>
    fs.writeFile(path.join(root, name), text);
  if (seed) {
    await write("file.txt", "first\n");
    await act("stageAll");
    await act("commit", { message: "Initial commit\n\nDetailed body." });
  }
  return { root, directory, git, signal, act, write };
}
describe("expanded source control", () => {
  it("handles missing repositories, unborn branches and bulk unstaging without losing files", async () => {
    const { root, git, act, write } = await setup(false);
    expect(await git.log({})).toEqual({ commits: [], hasMore: false });
    expect(await git.status()).toMatchObject({
      repository: true,
      branch: "main",
      head: undefined,
    });
    await write("a.txt", "a");
    await write("b.txt", "b");
    await act("stageAll");
    await write("a.txt", "newer");
    await act("unstageAll");
    expect((await git.status()).changes.every((c) => c.index === "?")).toBe(
      true,
    );
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("newer");
    await fs.rm(path.join(root, ".git"), { recursive: true });
    expect(await git.status()).toMatchObject({
      repository: false,
      branch: "",
      changes: [],
    });
  });
  it("stages literal special filenames and unstages both sides of a rename", async () => {
    const { root, git, act, write } = await setup();
    await write("*.txt", "literal");
    await write("other.txt", "other");
    await act("stage", { path: "*.txt" });
    expect(
      (await git.status()).changes.find((c) => c.path === "other.txt")?.index,
    ).toBe("?");
    await command(root, ["mv", "file.txt", "renamed.txt"]);
    expect(
      (await git.status()).changes.find((c) => c.path === "renamed.txt"),
    ).toMatchObject({ originalPath: "file.txt", index: "R" });
    expect((await git.diff("renamed.txt", true)).before).toBe("first\n");
    await act("unstage", { path: "renamed.txt" });
    expect(await command(root, ["diff", "--cached", "--name-only"])).toBe(
      "*.txt",
    );
    await expect(act("stage", { path: "../outside" })).rejects.toMatchObject({
      code: "PATH_DENIED",
    });
  });
  it("creates, renames, switches and safely deletes branches, preserving unmerged work", async () => {
    const { git, act, write } = await setup();
    await act("branchCreate", { name: "feature/work" });
    await act("branchRename", {
      branch: "feature/work",
      name: "feature/renamed",
    });
    expect((await git.status()).branch).toBe("feature/renamed");
    await write("feature.txt", "feature");
    await act("stageAll");
    await act("commit", { message: "Feature" });
    await act("checkout", { branch: "main" });
    await expect(
      act("branchDelete", { branch: "feature/renamed", confirm: true }),
    ).rejects.toMatchObject({ code: "GIT_FAILED" });
    await act("merge", { ref: "refs/heads/feature/renamed" });
    await act("branchDelete", { branch: "feature/renamed", confirm: true });
    expect((await git.status()).branches).toEqual(["main"]);
    for (const name of ["--force", "@{-1}", "a..b", "refs/heads/surprise"])
      await expect(act("branchCreate", { name })).rejects.toBeDefined();
  });
  it("paginates and searches history, and reviews initial, renamed and deleted files", async () => {
    const { root, git, act, write } = await setup();
    const initial = (await git.log({})).commits[0]!;
    expect(initial).toMatchObject({
      subject: "Initial commit",
      body: "Detailed body.",
      parents: [],
      author: "Oxbit Test",
    });
    expect(
      await git.commitDiff({ ref: initial.id, path: "file.txt" }),
    ).toMatchObject({ before: "", after: "first\n" });
    await command(root, ["mv", "file.txt", "new name.txt"]);
    await act("commit", { message: "Rename file" });
    const renamed = (await git.log({ limit: 1 })).commits[0]!;
    expect((await git.show(renamed.id)).files).toEqual([
      { path: "new name.txt", originalPath: "file.txt", status: "R100" },
    ]);
    expect(
      await git.commitDiff({ ref: renamed.id, path: "new name.txt" }),
    ).toMatchObject({ before: "first\n", after: "first\n" });
    await write("next.txt", "next");
    await act("stageAll");
    await act("commit", { message: "Next commit" });
    expect(await git.log({ limit: 2 })).toMatchObject({ hasMore: true });
    expect((await git.log({ skip: 2 })).commits[0]?.id).toBe(initial.id);
    expect(
      (await git.log({ search: "RENAME" })).commits.map((c) => c.subject),
    ).toEqual(["Rename file"]);
    expect((await git.log({ path: "next.txt" })).commits).toHaveLength(1);
    await fs.unlink(path.join(root, "new name.txt"));
    await act("stageAll");
    await act("commit", { message: "Delete" });
    expect(
      await git.commitDiff({ ref: "HEAD", path: "new name.txt" }),
    ).toMatchObject({ before: "first\n", after: "" });
  });
  it("stages and unstages individual hunks, rejecting stale snapshots", async () => {
    const { root, git, act, write } = await setup();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    await write("file.txt", lines.join("\n") + "\n");
    await act("stageAll");
    await act("commit", { message: "Lines" });
    lines[1] = "first edit";
    lines[25] = "second edit";
    await write("file.txt", lines.join("\n") + "\n");
    const diff = await git.diff("file.txt");
    expect(diff.hunks).toHaveLength(2);
    await act("hunk", {
      path: "file.txt",
      hunk: 0,
      fingerprint: diff.fingerprint,
    });
    expect(await command(root, ["show", ":file.txt"])).toContain("first edit");
    expect(await command(root, ["show", ":file.txt"])).not.toContain(
      "second edit",
    );
    await expect(
      act("hunk", { path: "file.txt", hunk: 1, fingerprint: diff.fingerprint }),
    ).rejects.toMatchObject({ code: "STALE_STATE" });
    const index = await git.diff("file.txt", true);
    await act("hunk", {
      path: "file.txt",
      staged: true,
      hunk: 0,
      fingerprint: index.fingerprint,
    });
    expect(await command(root, ["diff", "--cached"])).toBe("");
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toContain(
      "second edit",
    );
  });
  it("lists, previews, applies and pops stashes with untracked files and preserved index state", async () => {
    const { root, git, act, write } = await setup();
    await write("file.txt", "staged\n");
    await act("stageAll");
    await write("untracked.txt", "new\n");
    await act("stashSave", { message: "My work", includeUntracked: true });
    expect((await git.status()).changes).toEqual([]);
    const stash = (await git.stashes())[0]!;
    expect(stash.message).toContain("My work");
    expect((await git.stashDiff({ ...stash })).diff).toContain("+new");
    await act("stashApply", { ...stash });
    expect(
      (await git.status()).changes.find((c) => c.path === "file.txt")?.index,
    ).toBe("M");
    expect(await fs.readFile(path.join(root, "untracked.txt"), "utf8")).toBe(
      "new\n",
    );
    expect(await git.stashes()).toHaveLength(1);
    await act("stashSave", { message: "Again", includeUntracked: true });
    await expect(
      act("stashDrop", { ...stash, confirm: true }),
    ).rejects.toMatchObject({ code: "STALE_STATE" });
    const latest = (await git.stashes())[0]!;
    await act("stashPop", { ...latest });
    expect(await git.stashes()).toHaveLength(1);
    const remaining = (await git.stashes())[0]!;
    await expect(act("stashDrop", { ...remaining })).rejects.toMatchObject({
      code: "CONFIRM_REQUIRED",
    });
    await act("stashDrop", { ...remaining, confirm: true });
    expect(await git.stashes()).toEqual([]);
  });
  it("publishes, fetches, tracks remote branches and pulls without merging diverged history", async () => {
    const { root, directory, git, act, write } = await setup();
    const remote = path.join(directory, "remote.git"),
      clone = path.join(directory, "clone");
    await command(directory, [
      "init",
      "--bare",
      "--initial-branch=main",
      remote,
    ]);
    await act("remoteAdd", { name: "origin", url: pathToFileURL(remote).href });
    await act("publish", { remote: "origin" });
    expect(await git.status()).toMatchObject({
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
    });
    await command(directory, ["clone", remote, clone]);
    await command(clone, ["config", "user.name", "Other"]);
    await command(clone, ["config", "user.email", "other@example.test"]);
    await fs.writeFile(path.join(clone, "remote.txt"), "incoming");
    await command(clone, ["add", "."]);
    await command(clone, ["commit", "-m", "Incoming"]);
    await command(clone, ["push"]);
    await act("fetch");
    expect((await git.status()).behind).toBe(1);
    await act("pull");
    expect(await fs.readFile(path.join(root, "remote.txt"), "utf8")).toBe(
      "incoming",
    );
    await command(clone, ["switch", "-c", "remote-feature"]);
    await command(clone, ["push", "-u", "origin", "remote-feature"]);
    await act("fetch");
    await act("branchTrack", {
      ref: "refs/remotes/origin/remote-feature",
      name: "local-feature",
    });
    expect(await git.status()).toMatchObject({
      branch: "local-feature",
      upstream: "origin/remote-feature",
    });
    await act("checkout", { branch: "main" });
    await write("local.txt", "local");
    await act("stageAll");
    await act("commit", { message: "Local" });
    await command(clone, ["switch", "main"]);
    await fs.writeFile(path.join(clone, "other.txt"), "other");
    await command(clone, ["add", "."]);
    await command(clone, ["commit", "-m", "Diverged"]);
    await command(clone, ["push"]);
    await act("fetch");
    expect(await git.status()).toMatchObject({ ahead: 1, behind: 1 });
    const head = (await git.status()).head;
    await expect(act("pull")).rejects.toMatchObject({ code: "GIT_FAILED" });
    expect((await git.status()).head).toBe(head);
  });
  it("exposes merge conflicts, can abort, and can continue after resolutions are staged", async () => {
    const { git, act, write } = await setup();
    await act("branchCreate", { name: "other" });
    await write("file.txt", "other\n");
    await act("stageAll");
    await act("commit", { message: "Other" });
    await act("checkout", { branch: "main" });
    await write("file.txt", "main\n");
    await act("stageAll");
    await act("commit", { message: "Main" });
    await expect(act("merge", { ref: "other" })).rejects.toMatchObject({
      code: "GIT_FAILED",
    });
    expect(await git.status()).toMatchObject({
      operation: "merge",
      changes: [expect.objectContaining({ conflict: true })],
    });
    await expect(act("continue", { operation: "merge" })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    await act("abort", { operation: "merge", confirm: true });
    expect((await git.status()).changes).toEqual([]);
    await expect(act("merge", { ref: "other" })).rejects.toBeDefined();
    await write("file.txt", "resolved\n");
    await act("stage", { path: "file.txt" });
    await act("continue", { operation: "merge" });
    expect((await git.status()).operation).toBeUndefined();
    expect((await git.log({ limit: 1 })).commits[0]?.parents).toHaveLength(2);
  });
  it("cherry-picks and reverts commits without rewriting earlier history", async () => {
    const { git, act, write } = await setup();
    await act("branchCreate", { name: "other" });
    await write("new.txt", "new");
    await act("stageAll");
    await act("commit", { message: "Add new" });
    const ref = (await git.status()).head;
    await act("checkout", { branch: "main" });
    await act("cherryPick", { ref, confirm: true });
    const picked = (await git.status()).head;
    await act("revert", { ref: picked, confirm: true });
    expect((await git.log({})).commits.map((c) => c.subject)).toEqual([
      'Revert "Add new"',
      "Add new",
      "Initial commit",
    ]);
  });
  it("keeps binary and oversized files usable through whole-file actions", async () => {
    const { git, act, write } = await setup();
    await write("binary.dat", "before\0binary");
    await act("stageAll");
    await act("commit", { message: "Binary" });
    await write("binary.dat", "after\0binary");
    expect(await git.diff("binary.dat")).toMatchObject({
      binary: true,
      before: "",
      after: "",
      hunks: [],
    });
    await write("large.txt", "x".repeat(1024 * 1024 + 1));
    await expect(git.diff("large.txt")).rejects.toMatchObject({
      code: "OUTPUT_LIMIT",
    });
    await act("stage", { path: "large.txt" });
    expect(
      (await git.status()).changes.find((change) => change.path === "large.txt")
        ?.index,
    ).toBe("A");
  });
  it("retains a stash when restoring it conflicts", async () => {
    const { git, act, write } = await setup();
    await write("file.txt", "stashed\n");
    await act("stashSave", { message: "Retain on conflict" });
    const stash = (await git.stashes())[0]!;
    await write("file.txt", "committed\n");
    await act("stageAll");
    await act("commit", { message: "Intervening change" });
    await expect(act("stashPop", { ...stash })).rejects.toMatchObject({
      code: "GIT_FAILED",
    });
    expect((await git.stashes())[0]?.id).toBe(stash.id);
    expect((await git.status()).changes.some((change) => change.conflict)).toBe(
      true,
    );
  });
  it("recognizes and aborts a rebase started in a terminal", async () => {
    const { root, git, act, write } = await setup();
    await act("branchCreate", { name: "other" });
    await write("file.txt", "other\n");
    await act("stageAll");
    await act("commit", { message: "Other" });
    await act("checkout", { branch: "main" });
    await write("file.txt", "main\n");
    await act("stageAll");
    await act("commit", { message: "Main" });
    const head = (await git.status()).head;
    await expect(command(root, ["rebase", "other"])).rejects.toBeDefined();
    expect((await git.status()).operation).toBe("rebase");
    await expect(act("continue", { operation: "merge" })).rejects.toMatchObject(
      { code: "STALE_STATE" },
    );
    await act("abort", { operation: "rebase", confirm: true });
    expect(await git.status()).toMatchObject({
      branch: "main",
      head,
      changes: [],
    });
  });
});
