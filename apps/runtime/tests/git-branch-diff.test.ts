import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Git } from "../src/git.js";
import { WorkspaceFiles } from "../src/filesystem.js";
import { runCommand } from "../src/processes.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
async function setup(branch = "main") {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-branch-diff-")));
  directories.push(directory);
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  const git = async (...args: string[]) => {
    const result = await runCommand(
      "git",
      ["-c", "user.name=Oxbit Test", "-c", "user.email=oxbit@example.test", "-c", "commit.gpgsign=false", ...args],
      { cwd: root },
    );
    if (result.exitCode) throw new Error(result.stderr + result.stdout);
    return result.stdout.trim();
  };
  const write = (name: string, text: string | Buffer) => fs.writeFile(path.join(root, name), text);
  const commit = async (name: string, text: string, message: string) => {
    await write(name, text);
    await git("add", name);
    await git("commit", "-qm", message);
  };
  await git("init", "-q", `--initial-branch=${branch}`);
  await commit("base.txt", "base\n", "base");
  return { directory, root, git, write, commit, diff: (params = {}) => new Git(new WorkspaceFiles(root)).branchDiff(params) };
}

describe("git.branchDiff", () => {
  it("answers outside a repository", async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-branch-diff-")));
    directories.push(directory);
    expect(await new Git(new WorkspaceFiles(directory)).branchDiff({})).toEqual({ repository: false });
  });

  it("includes committed, staged, unstaged and untracked changes since the merge base with main", async () => {
    const { git, write, commit, diff } = await setup();
    await git("checkout", "-qb", "feature");
    await commit("feature.txt", "committed on feature\n", "feature work");
    await write("base.txt", "base\nstaged line\n");
    await git("add", "base.txt");
    await write("base.txt", "base\nstaged line\nunstaged line\n");
    await write("notes.md", "untracked note\n");
    await write("image.bin", Buffer.from([0, 1, 2, 0, 3]));

    const result = await diff();
    if ("repository" in result) throw new Error("expected a repository");
    expect(result).toMatchObject({ base: "main", head: "feature", truncated: false });
    const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]));
    expect(Object.keys(byPath).sort()).toEqual(["base.txt", "feature.txt", "image.bin", "notes.md"]);
    expect(byPath["feature.txt"].diff).toContain("+committed on feature");
    expect(byPath["base.txt"].diff).toContain("+staged line");
    expect(byPath["base.txt"].diff).toContain("+unstaged line");
    expect(byPath["notes.md"].diff).toContain("new file mode");
    expect(byPath["notes.md"].diff).toContain("+untracked note");
    expect(byPath["image.bin"]).toMatchObject({ binary: true });
    expect(byPath["notes.md"].binary).toBe(false);

    const probe = await diff({ limit: 0 });
    expect(probe).toMatchObject({ base: "main", files: [], truncated: true });
    await expect(diff({ limit: 51 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(diff({ limit: "1" })).resolves.toMatchObject({ truncated: true });
  });

  it("compares with the upstream remote's default branch before local main", async () => {
    const { directory, git, commit, diff } = await setup();
    const remote = path.join(directory, "remote.git");
    await runCommand("git", ["init", "-q", "--bare", remote], { cwd: directory });
    await git("remote", "add", "upstream", remote);
    await git("push", "-q", "upstream", "main");
    await git("remote", "set-head", "upstream", "main");
    await commit("local-main.txt", "only on local main\n", "local main");
    await git("checkout", "-qb", "feature");
    await git("config", "branch.feature.remote", "upstream");
    await git("config", "branch.feature.merge", "refs/heads/feature");
    const result = await diff();
    expect(result).toMatchObject({ base: "upstream/main", head: "feature" });
    expect(JSON.stringify(result)).toContain("+only on local main");

    await git("checkout", "-q", "main");
    expect(await diff()).toMatchObject({ base: "main", head: "main", files: [] });
  });

  it("reports a missing base branch and caps large diffs", async () => {
    const { git, write, diff } = await setup("trunk");
    await expect(diff()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await git("branch", "master");
    await write("big.txt", "x".repeat(120_000) + "\n");
    await write("bigger.txt", "y".repeat(120_000) + "\n");
    const result = await diff();
    if ("repository" in result) throw new Error("expected a repository");
    expect(result).toMatchObject({ base: "master", head: "trunk", truncated: true });
    expect(result.files.reduce((size, file) => size + file.diff.length, 0)).toBe(200_000);
  });
});
