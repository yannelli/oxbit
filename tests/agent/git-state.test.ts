import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain-node module without types
import { parseStatusV2, worktreeState } from "../../scripts/agent/lib/git-state.mjs";
import { pushedRepo, tempDir } from "./hooks-helpers";

describe("parseStatusV2", () => {
  it("reads branch, upstream, ahead, behind and dirty entries", () => {
    const output = [
      "# branch.oid 1234567890abcdef",
      "# branch.head feat/x",
      "# branch.upstream origin/feat/x",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts",
      "? notes.md",
      "",
    ].join("\n");
    expect(parseStatusV2(output)).toEqual({ branch: "feat/x", upstream: "origin/feat/x", ahead: 2, behind: 3, dirty: 3 });
  });
  it("leaves upstream empty on a branch that tracks nothing", () => {
    expect(parseStatusV2("# branch.oid abc\n# branch.head main\n")).toEqual({ branch: "main", upstream: null, ahead: 0, behind: 0, dirty: 0 });
  });
  it("reads a detached head", () => {
    expect(parseStatusV2("# branch.oid abc\n# branch.head (detached)\n").branch).toBe("(detached)");
  });
});

describe("worktreeState", () => {
  it("reports a clean pushed repo and a dirty one", () => {
    const repo = pushedRepo(tempDir("git-state-"));
    expect(worktreeState(repo)).toMatchObject({ path: repo, branch: "main", upstream: "origin/main", dirty: 0, unpushed: 0 });
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    expect(worktreeState(repo)).toMatchObject({ dirty: 1, unpushed: 0 });
  });
  it("returns an error outside a repository", () => {
    const dir = tempDir("git-state-none-");
    expect(worktreeState(dir)).toMatchObject({ path: dir, error: expect.any(String) });
  });
});
