import { describe, expect, it } from "vitest";
// @ts-expect-error plain-node hook module without types
import { STASH_BLOCK_MESSAGE, stashBlockReason } from "../../scripts/agent/hooks/stash.mjs";
// @ts-expect-error plain-node hook module without types
import { simpleCommands, splitSegments } from "../../scripts/agent/hooks/shell-words.mjs";

const blocked = [
  "git stash",
  "git stash pop",
  "git stash pop stash@{1}",
  "git stash clear",
  "git stash push",
  "git stash push -u",
  "git stash push -- src/a.ts",
  "git stash save",
  "git stash -u",
  "git stash push -m \"\"",
  "git -C ../other stash",
  "git -c core.pager=cat stash pop",
  "/usr/bin/git stash",
  "FOO=1 git stash",
  "sudo git stash",
];

const allowed = [
  "git stash list",
  "git stash list --format='%H %gs'",
  "git stash list 2>&1 | head",
  "git stash show -p stash@{0}",
  "git stash apply 3f2a1bc",
  "git stash drop stash@{2}",
  "git stash push -u -m \"wip-hooks-1\"",
  "git stash push -m wip",
  "git stash push --message=wip -- src",
  "git stash push --message wip",
  "git stash push -um wip",
  "git stash push -mwip",
  "git stash save \"legacy message\"",
  "git stash -m wip",
  "git status",
  "echo \"git stash\"",
  "grep -n 'git stash pop' notes.md",
  "ls",
];

const compound = [
  "cd x && git stash",
  "git fetch; git stash pop",
  "make || git stash",
  "git add . | git stash",
  "(cd ../y && git stash pop)",
  "echo $(git stash)",
  "echo `git stash pop`",
  "bash -c \"git stash\"",
  "zsh -lc 'cd x && git stash pop'",
  "git status\ngit stash",
  "git stash 2>&1 | tail -1",
  "git stash > /dev/null",
  "git stash &>/dev/null",
];

describe("git stash guard", () => {
  it.each(blocked)("blocks %s", (command) => {
    expect(stashBlockReason(command)).toBe(STASH_BLOCK_MESSAGE);
  });
  it.each(allowed)("allows %s", (command) => {
    expect(stashBlockReason(command)).toBeNull();
  });
  it.each(compound)("blocks inside compound command %s", (command) => {
    expect(stashBlockReason(command)).toBe(STASH_BLOCK_MESSAGE);
  });
  it("allows a compound command whose stash calls all carry a message", () => {
    expect(stashBlockReason("cd x && git stash push -u -m tag-1 && git stash list")).toBeNull();
  });
  it("names the shared stack and the safe route in the block message", () => {
    expect(STASH_BLOCK_MESSAGE).toContain("shared by every worktree");
    expect(STASH_BLOCK_MESSAGE).toContain("WIP commit");
    expect(STASH_BLOCK_MESSAGE).toContain("git stash apply <sha>");
  });
});

describe("shell word splitting", () => {
  it("splits on control operators and keeps quoted text whole", () => {
    expect(splitSegments("a 'b c' && d \"e;f\" ; g | h")).toEqual([["a", "b c"], ["d", "e;f"], ["g"], ["h"]]);
  });
  it("keeps redirects inside the segment and skips comments", () => {
    expect(splitSegments("a 2>&1 # git stash")).toEqual([["a", "2>&1"]]);
  });
  it("strips assignments and wrappers and expands shell -c strings", () => {
    expect(simpleCommands("A=1 env sudo /usr/bin/git status && sh -c 'gh pr merge 3'")).toEqual([
      ["git", "status"],
      ["gh", "pr", "merge", "3"],
    ]);
  });
});
