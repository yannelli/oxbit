import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  Git,
  GH_SETUP,
  pullRequestArgs,
  pullRequestError,
  pullRequestUrl,
  type InputCommand,
} from "../src/git.js";
import { WorkspaceFiles } from "../src/filesystem.js";
import { runCommand } from "../src/processes.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
const command = async (cwd: string, args: string[]) => {
  const result = await runCommand("git", args, { cwd });
  if (result.exitCode) throw new Error(result.stderr);
  return result.stdout.trim();
};
async function setup(runner: InputCommand, publish = true) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-pr-")));
  directories.push(directory);
  const root = path.join(directory, "workspace"),
    remote = path.join(directory, "remote.git");
  await fs.mkdir(root);
  await command(directory, ["init", "--bare", "--initial-branch=main", remote]);
  await command(root, ["init", "--initial-branch=main"]);
  await command(root, ["config", "user.name", "Oxbit Test"]);
  await command(root, ["config", "user.email", "oxbit@example.test"]);
  await fs.writeFile(path.join(root, "file.txt"), "first\n");
  await command(root, ["add", "file.txt"]);
  await command(root, ["commit", "-m", "Seed"]);
  await command(root, ["remote", "add", "origin", pathToFileURL(remote).href]);
  if (publish) await command(root, ["push", "--set-upstream", "origin", "main"]);
  return { root, git: new Git(new WorkspaceFiles(root), "git", runner) };
}
const signal = new AbortController().signal;

describe("gh pull request helpers", () => {
  it("builds a draft pull request command that reads the body from stdin", () => {
    expect(pullRequestArgs("-Fix it", "main")).toEqual([
      "pr", "create", "--draft", "--title", "-Fix it", "--body-file", "-", "--base", "main",
    ]);
  });
  it("maps a missing or signed-out gh to the setup message", () => {
    expect(pullRequestError(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }))).toMatchObject({
      code: "GH_UNAVAILABLE",
      message: GH_SETUP,
    });
    expect(
      pullRequestError({ exitCode: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }),
    ).toMatchObject({ code: "GH_UNAVAILABLE", message: GH_SETUP });
  });
  it("passes other gh failures through", () => {
    const error = pullRequestError({
      exitCode: 1,
      stdout: "",
      stderr: "a pull request for branch \"x\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/7\n",
    });
    expect(error.code).toBe("GH_FAILED");
    expect(error.message).toContain("https://github.com/o/r/pull/7");
  });
  it("reads the URL from the last stdout line", () => {
    expect(pullRequestUrl("Creating draft pull request\nhttps://github.com/o/r/pull/9\n")).toBe(
      "https://github.com/o/r/pull/9",
    );
    expect(() => pullRequestUrl("nothing")).toThrow("nothing");
  });
});

describe("createPullRequest", () => {
  it("runs gh in the repository root with the default branch from gh repo view", async () => {
    const calls: { args: string[]; cwd: string; input: string; prompt?: string }[] = [];
    const runner: InputCommand = async (_command, args, options) => {
      calls.push({ args, cwd: options.cwd, input: options.input, prompt: options.env.GH_PROMPT_DISABLED });
      return args[0] === "repo"
        ? { stdout: "trunk\n", stderr: "", exitCode: 0 }
        : { stdout: "https://github.com/o/r/pull/3\n", stderr: "", exitCode: 0 };
    };
    const { root, git } = await setup(runner);
    await expect(
      git.action("createPullRequest", { title: "Add file", body: "Why\n" }, signal, () => {}),
    ).resolves.toEqual({ url: "https://github.com/o/r/pull/3" });
    expect(calls[1]).toEqual({
      args: pullRequestArgs("Add file", "trunk"),
      cwd: root,
      input: "Why\n",
      prompt: "1",
    });
  });
  it("falls back to the local default branch when gh cannot read the repository", async () => {
    const calls: string[][] = [];
    const runner: InputCommand = async (_command, args) => {
      calls.push(args);
      return args[0] === "repo"
        ? { stdout: "", stderr: "no GitHub remotes found", exitCode: 1 }
        : { stdout: "https://github.com/o/r/pull/4\n", stderr: "", exitCode: 0 };
    };
    const { git } = await setup(runner);
    await git.action("createPullRequest", { title: "Add file" }, signal, () => {});
    expect(calls[1]).toEqual(pullRequestArgs("Add file", "main"));
  });
  it("reports gh setup and missing upstream errors", async () => {
    const missing: InputCommand = async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    };
    const published = await setup(missing);
    await expect(
      published.git.action("createPullRequest", { title: "T", base: "main" }, signal, () => {}),
    ).rejects.toMatchObject({ message: GH_SETUP });
    const local = await setup(missing, false);
    await expect(
      local.git.action("createPullRequest", { title: "T", base: "main" }, signal, () => {}),
    ).rejects.toMatchObject({ code: "NO_UPSTREAM" });
    await expect(
      local.git.action("createPullRequest", { title: "T", base: "--force" }, signal, () => {}),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});

describe("pull", () => {
  it("rebases local commits onto diverged upstream commits when asked", async () => {
    const { root, git } = await setup(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const other = path.join(path.dirname(root), "other");
    await command(path.dirname(root), ["clone", (await command(root, ["remote", "get-url", "origin"])), other]);
    await command(other, ["config", "user.name", "Oxbit Test"]);
    await command(other, ["config", "user.email", "oxbit@example.test"]);
    await fs.writeFile(path.join(other, "remote.txt"), "remote\n");
    await command(other, ["add", "remote.txt"]);
    await command(other, ["commit", "-m", "Remote"]);
    await command(other, ["push"]);
    await fs.writeFile(path.join(root, "local.txt"), "local\n");
    await command(root, ["add", "local.txt"]);
    await command(root, ["commit", "-m", "Local"]);
    await command(root, ["fetch"]);
    await expect(git.action("pull", {}, signal, () => {})).rejects.toMatchObject({ code: "GIT_FAILED" });
    await git.action("pull", { rebase: true }, signal, () => {});
    expect(await command(root, ["log", "--format=%s"])).toBe("Local\nRemote\nSeed");
  });
});

describe("amend", () => {
  it("replaces the last commit message and keeps one commit", async () => {
    const { root, git } = await setup(async () => ({ stdout: "", stderr: "", exitCode: 0 }), false);
    await fs.writeFile(path.join(root, "file.txt"), "second\n");
    await command(root, ["add", "file.txt"]);
    await git.action("amend", { message: "Seed with second line" }, signal, () => {});
    expect(await command(root, ["log", "--format=%s"])).toBe("Seed with second line");
    expect(await command(root, ["show", "HEAD:file.txt"])).toBe("second");
  });
});
