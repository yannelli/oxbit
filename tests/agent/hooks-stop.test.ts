import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain-node hook module without types
import { alreadyContinued, describeState, stopDirectory } from "../../scripts/agent/hooks/stop.mjs";
import { git, pushedRepo, runHook, tempDir } from "./hooks-helpers";

let clean = "";
let dirty = "";
let ahead = "";
let unpublished = "";

beforeAll(() => {
  clean = pushedRepo(tempDir("stop-clean-"));
  dirty = pushedRepo(tempDir("stop-dirty-"));
  fs.writeFileSync(path.join(dirty, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(dirty, "new.txt"), "new\n");
  ahead = pushedRepo(tempDir("stop-ahead-"));
  fs.writeFileSync(path.join(ahead, "b.txt"), "b\n");
  git(ahead, "add", "b.txt");
  git(ahead, "commit", "-m", "second");
  unpublished = pushedRepo(tempDir("stop-unpublished-"));
  git(unpublished, "switch", "-c", "feat/local");
  fs.writeFileSync(path.join(unpublished, "c.txt"), "c\n");
  git(unpublished, "add", "c.txt");
  git(unpublished, "commit", "-m", "local only");
});

describe("stop hook worktree warning", () => {
  it("stays quiet in a clean, pushed worktree", () => {
    expect(runHook("claude", "stop", { cwd: clean, stop_hook_active: false })).toMatchObject({ status: 0, stdout: "" });
    expect(runHook("codex", "stop", { cwd: clean, stop_hook_active: false }).stdout).toBe("");
    expect(JSON.parse(runHook("cursor", "stop", { workspace_roots: [clean], status: "completed", loop_count: 0 }).stdout)).toEqual({});
  });
  it("warns Claude Code about uncommitted changes with a block decision", () => {
    const result = runHook("claude", "stop", { cwd: dirty, stop_hook_active: false });
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("2 uncommitted changes");
    expect(output.reason).toContain(dirty);
  });
  it("warns Codex with the same block decision", () => {
    const output = JSON.parse(runHook("codex", "stop", { cwd: dirty, stop_hook_active: false }).stdout);
    expect(output).toMatchObject({ decision: "block" });
  });
  it("warns Cursor with a follow-up message", () => {
    const output = JSON.parse(runHook("cursor", "stop", { workspace_roots: [dirty], status: "completed", loop_count: 0 }).stdout);
    expect(output.followup_message).toContain("uncommitted");
  });
  it("warns about commits ahead of the upstream", () => {
    const output = JSON.parse(runHook("claude", "stop", { cwd: ahead }).stdout);
    expect(output.reason).toContain("1 unpushed commit ahead of origin/main");
  });
  it("warns about a branch with no upstream", () => {
    const output = JSON.parse(runHook("claude", "stop", { cwd: unpublished }).stdout);
    expect(output.reason).toContain("1 unpushed commit on no remote branch");
  });
  it("warns once per stop sequence", () => {
    expect(runHook("claude", "stop", { cwd: dirty, stop_hook_active: true }).stdout).toBe("");
    expect(runHook("codex", "stop", { cwd: dirty, stop_hook_active: true }).stdout).toBe("");
    expect(JSON.parse(runHook("cursor", "stop", { workspace_roots: [dirty], loop_count: 1 }).stdout)).toEqual({});
  });
  it("stays quiet outside a git repository", () => {
    expect(runHook("claude", "stop", { cwd: tempDir("stop-norepo-") }).stdout).toBe("");
  });
});

describe("stop helpers", () => {
  it("picks the directory per tool", () => {
    expect(stopDirectory({ cwd: "/a", workspace_roots: ["/b"] })).toBe("/a");
    expect(stopDirectory({ workspace_roots: ["/b"] })).toBe("/b");
  });
  it("reads each tool's loop flag", () => {
    expect(alreadyContinued({ stop_hook_active: true })).toBe(true);
    expect(alreadyContinued({ loop_count: 2 })).toBe(true);
    expect(alreadyContinued({ stop_hook_active: false, loop_count: 0 })).toBe(false);
  });
  it("ignores git errors", () => {
    expect(describeState({ path: "/x", error: "not a git repository" })).toBeNull();
  });
});
