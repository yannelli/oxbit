import { describe, expect, it, vi } from "vitest";
import type { GitStatus } from "@oxbit/sdk";
import {
  budgetDiffs,
  cleanCommitMessage,
  collectDiffs,
  commitMessagePrompt,
  commitPlanPrompt,
  parseCommitPlan,
  parsePullRequest,
  pullRequestRemote,
} from "./ai.js";

describe("diff budget", () => {
  it("keeps small diffs whole and gives large ones an equal share", () => {
    const files = [
      { path: "big-a", status: "M", diff: "a".repeat(5000) },
      { path: "small", status: "M", diff: "s".repeat(100) },
      { path: "big-b", status: "M", diff: "b".repeat(9000) },
    ];
    const [a, small, b] = budgetDiffs(files, 1100);
    expect(small!.diff).toBe(files[1]!.diff);
    expect(a!.diff.startsWith("a".repeat(500))).toBe(true);
    expect(a!.diff).toContain("[4500 more characters omitted]");
    expect(b!.diff).toContain("[8500 more characters omitted]");
  });
});

describe("prompt builders", () => {
  const files = [{ path: "src/a.ts", status: "M", diff: "+added" }];
  it("asks for a short imperative subject and includes style examples", () => {
    const request = commitMessagePrompt(files, ["Fix the parser", "Add tests"]);
    expect(request.system).toContain("under 72 characters in imperative mood");
    expect(request.system).toContain("No code fences");
    expect(request.prompt).toContain("- Fix the parser");
    expect(request.prompt).toContain("M src/a.ts");
    expect(request.prompt).toContain("### src/a.ts\n+added");
  });
  it("asks for a JSON commit plan over the changed paths", () => {
    const request = commitPlanPrompt(files, []);
    expect(request.system).toContain('[{ "message": string, "files": string[] }]');
    expect(request.prompt).toContain("This repository has no commits yet.");
    expect(request.prompt).toContain("M src/a.ts");
  });
});

describe("commit plan parser", () => {
  const paths = [{ path: "a.ts" }, { path: "b.ts", originalPath: "old-b.ts" }, { path: "c.ts" }, { path: "d.ts" }];
  it("strips fences, drops unknown and repeated paths and collects leftovers", () => {
    const plan = parseCommitPlan(
      'Here you go:\n```json\n[{"message":"Add a","files":["./a.ts","x.ts"]},{"message":"Empty","files":["zzz"]},{"message":"Add b","files":["b.ts","a.ts"]}]\n```',
      paths,
    );
    expect(plan).toEqual([
      { message: "Add a", files: [{ path: "a.ts" }] },
      { message: "Add b", files: [{ path: "b.ts", originalPath: "old-b.ts" }] },
      { message: "Update remaining files", files: [{ path: "c.ts" }, { path: "d.ts" }] },
    ]);
  });
  it("rejects responses without a JSON list", () => {
    expect(() => parseCommitPlan("no idea", paths)).toThrow("did not contain JSON");
    expect(() => parseCommitPlan("[not json]", paths)).toThrow("invalid JSON");
  });
  it("fills a missing message from the first file", () => {
    expect(parseCommitPlan('[{"files":["c.ts"]}]', [{ path: "c.ts" }])).toEqual([
      { message: "Update c.ts", files: [{ path: "c.ts" }] },
    ]);
  });
});

describe("response cleanup", () => {
  it("removes fences and wrapping quotes from a commit message", () => {
    expect(cleanCommitMessage('```\n"Fix login"\n```')).toBe("Fix login");
    expect(cleanCommitMessage("Add x\n\n\n\nBecause y")).toBe("Add x\n\nBecause y");
  });
  it("parses pull request JSON", () => {
    expect(parsePullRequest('```json\n{"title":" Add x ","body":"Why"}\n```')).toEqual({
      title: "Add x",
      body: "Why",
    });
    expect(() => parsePullRequest('{"body":"x"}')).toThrow("no pull request title");
  });
});

describe("diff collection", () => {
  it("reads staged diffs and synthesizes patches for untracked files", async () => {
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      params.path === "new.txt"
        ? { before: "", after: "hello", diff: "" }
        : params.path === "big.bin"
          ? Promise.reject(Object.assign(new Error("too large"), { code: "OUTPUT_LIMIT" }))
          : { before: "", after: "", diff: params.staged ? "staged" : "unstaged" },
    ) as any;
    const changes = [
      { path: "both.ts", index: "M", working: "M" },
      { path: "new.txt", index: "?", working: "?" },
      { path: "big.bin", index: " ", working: "M" },
    ];
    const all = await collectDiffs(request, changes, "all");
    expect(all.map((file) => file.diff)).toEqual([
      "staged\nunstaged",
      "--- /dev/null\n+++ b/new.txt\n+hello",
      "(diff too large to include)",
    ]);
    expect(all[1]!.status).toBe("A");
    const staged = await collectDiffs(request, changes.slice(0, 1), "staged");
    expect(staged[0]!.diff).toBe("staged");
  });
});

describe("pull request remote", () => {
  const status = (remotes: GitStatus["remotes"], upstream?: string) =>
    ({ remotes, upstream }) as GitStatus;
  it("uses the upstream remote and requires github.com", () => {
    const remotes = [
      { name: "origin", fetchUrl: "git@github.com:o/r.git", pushUrl: "git@github.com:o/r.git" },
      { name: "origin-mirror", fetchUrl: "https://gitlab.com/o/r", pushUrl: "https://gitlab.com/o/r" },
    ];
    expect(pullRequestRemote(status(remotes, "origin/main"))).toBe("origin");
    expect(pullRequestRemote(status(remotes, "origin-mirror/main"))).toBeUndefined();
    expect(pullRequestRemote(status(remotes))).toBe("origin");
    expect(pullRequestRemote(status([{ name: "up", fetchUrl: "", pushUrl: "https://notgithub.com/x" }]))).toBeUndefined();
  });
});
