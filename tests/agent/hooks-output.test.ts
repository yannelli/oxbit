import { describe, expect, it } from "vitest";
// @ts-expect-error plain-node hook module without types
import { allowOutput, denyOutput, failOpenOutput, stopOutput } from "../../scripts/agent/hooks/output.mjs";
// @ts-expect-error plain-node hook module without types
import { shellCommand } from "../../scripts/agent/hooks/run.mjs";
import { runHook } from "./hooks-helpers";

describe("hook output per tool", () => {
  it("denies Claude Code and Codex with permissionDecision", () => {
    for (const tool of ["claude", "codex"]) {
      expect(JSON.parse(denyOutput(tool, "why"))).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "why" },
      });
      expect(allowOutput(tool)).toBe("");
      expect(JSON.parse(stopOutput(tool, "warn"))).toEqual({ decision: "block", reason: "warn" });
      expect(stopOutput(tool, null)).toBe("");
    }
  });
  it("denies Cursor with permission and both messages", () => {
    expect(JSON.parse(denyOutput("cursor", "why"))).toEqual({ permission: "deny", user_message: "why", agent_message: "why" });
    expect(JSON.parse(allowOutput("cursor"))).toEqual({ permission: "ask" });
    expect(JSON.parse(stopOutput("cursor", "warn"))).toEqual({ followup_message: "warn" });
    expect(JSON.parse(stopOutput("cursor", null))).toEqual({});
  });
  it("fails open with each tool's allow shape", () => {
    expect(failOpenOutput("claude", "pre-shell")).toBe("");
    expect(JSON.parse(failOpenOutput("cursor", "pre-shell"))).toEqual({ permission: "ask" });
    expect(JSON.parse(failOpenOutput("cursor", "stop"))).toEqual({});
  });
});

describe("hook entry point", () => {
  it("reads the command from each tool's stdin shape", () => {
    expect(shellCommand({ tool_input: { command: "git stash" } })).toBe("git stash");
    expect(shellCommand({ command: "git stash" })).toBe("git stash");
    expect(shellCommand({ tool_input: { command: ["bash", "-lc", "git stash pop"] } })).toBe("git stash pop");
    expect(shellCommand({})).toBe("");
  });
  it("allows a non-matching command with no output", () => {
    expect(runHook("claude", "pre-shell", { tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({ status: 0, stdout: "", stderr: "" });
  });
  it("blocks bare git stash for each tool", () => {
    const claude = JSON.parse(runHook("claude", "pre-shell", { tool_input: { command: "git stash" } }).stdout);
    expect(claude.hookSpecificOutput.permissionDecision).toBe("deny");
    const codex = JSON.parse(runHook("codex", "pre-shell", { tool_name: "Bash", tool_input: { command: "cd x && git stash pop" } }).stdout);
    expect(codex.hookSpecificOutput.permissionDecisionReason).toContain("shared by every worktree");
    expect(JSON.parse(runHook("cursor", "pre-shell", { command: "git stash", cwd: "/" }).stdout).permission).toBe("deny");
  });
  it("fails open on bad stdin, unknown tools and unknown events", () => {
    const bad = runHook("claude", "pre-shell", "not json");
    expect(bad).toMatchObject({ status: 0, stdout: "" });
    expect(bad.stderr).toContain("allowed after an error");
    expect(JSON.parse(runHook("cursor", "pre-shell", "not json").stdout)).toEqual({ permission: "ask" });
    expect(runHook("vim", "pre-shell", { command: "git stash" })).toMatchObject({ status: 0, stdout: "" });
    expect(runHook("claude", "post", { command: "git stash" })).toMatchObject({ status: 0, stdout: "" });
  });
});
