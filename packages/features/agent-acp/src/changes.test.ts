import { describe, expect, it } from "vitest";
import { MAX_CHANGES_TEXT, branchChanges, commitChanges, uncommittedChanges } from "./changes.js";

const runtime = (status: unknown, diff: (params: any) => unknown = () => ({ diff: "", after: "", binary: false })) =>
  async <T,>(method: string, params?: Record<string, unknown>) =>
    (method === "git.status" ? status : diff(params)) as T;

describe("uncommittedChanges", () => {
  it("rejects workspaces without a repository or without changes", async () => {
    await expect(uncommittedChanges(runtime({ repository: false, changes: [] }))).rejects.toThrow("not a git repository");
    await expect(uncommittedChanges(runtime({ repository: true, changes: [] }))).rejects.toThrow("No uncommitted changes");
  });

  it("joins staged and unstaged patches, lists failures inline, and truncates", async () => {
    const changes = [
      { path: "a.ts", index: "M", working: "M" },
      { path: "gone.ts", index: " ", working: "D" },
    ];
    const text = await uncommittedChanges(runtime({ repository: true, changes }, (params) => {
      if (params.path === "gone.ts") throw new Error("missing");
      return { diff: params.staged ? "staged patch" : "working patch", after: "", binary: false };
    }));
    expect(text).toBe("staged patch\nworking patch\ngone.ts: missing");
    const long = await uncommittedChanges(runtime({ repository: true, changes: [{ path: "big", index: "?", working: "?" }] },
      () => ({ diff: "", after: "x".repeat(MAX_CHANGES_TEXT), binary: false })));
    expect(long.length).toBeLessThanOrEqual(MAX_CHANGES_TEXT);
    expect(long.endsWith("[uncommitted changes truncated]")).toBe(true);
  });
});

describe("branchChanges", () => {
  const answer = (result: unknown) => async <T,>() => result as T;
  it("rejects missing repositories and empty diffs", async () => {
    await expect(branchChanges(answer({ repository: false }))).rejects.toThrow("not a git repository");
    await expect(branchChanges(answer({ base: "main", head: "main", files: [], truncated: false }))).rejects.toThrow("No changes against main");
  });
  it("labels the range and lists binary, oversized and truncated files", async () => {
    const result = await branchChanges(answer({
      base: "origin/main", head: "feature", truncated: true,
      files: [
        { path: "a.ts", diff: "diff --git a/a.ts b/a.ts\n+added", binary: false },
        { path: "logo.png", diff: "Binary files differ", binary: true },
        { path: "huge.json", diff: "", binary: false },
      ],
    }));
    expect(result.label).toBe("Branch diff: origin/main...feature");
    expect(result.text).toBe([
      "Changes on feature since its merge base with origin/main, including uncommitted changes",
      "",
      "diff --git a/a.ts b/a.ts\n+added",
      "binary file changed logo.png",
      "huge.json: diff exceeds the size limit",
      "[branch diff truncated]",
    ].join("\n"));
  });
});

describe("commitChanges", () => {
  const commit = { id: "abc1234def", parents: ["p"], author: "Ada", date: "2026-10-10T12:00:00Z", subject: "Fix login", body: "Details.", refs: "" };
  it("joins the message with each file's diff and reports failures inline", async () => {
    const calls: unknown[] = [];
    const text = await commitChanges(async <T,>(method: string, params?: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "git.show") return { commit, files: [{ path: "a.ts", status: "M" }, { path: "b.png", status: "A" }, { path: "gone", status: "D" }] } as T;
      if (params?.path === "gone") throw new Error("missing");
      return { diff: "patch a", after: "", binary: params?.path === "b.png" } as T;
    }, "abc1234");
    expect(calls[0]).toEqual(["git.show", { ref: "abc1234" }]);
    expect(calls[1]).toEqual(["git.commitDiff", { ref: "abc1234def", path: "a.ts" }]);
    expect(text).toBe("commit abc1234def\nAuthor: Ada\nDate: 2026-10-10T12:00:00Z\n\nFix login\n\nDetails.\n\npatch a\nbinary file changed b.png\ngone: missing");
  });
  it("caps files and text", async () => {
    const files = Array.from({ length: 60 }, (_, index) => ({ path: `f${index}`, status: "M" }));
    let diffs = 0;
    const text = await commitChanges(async <T,>(method: string) => {
      if (method === "git.show") return { commit: { ...commit, body: "" }, files } as T;
      diffs++;
      return { diff: "x".repeat(150_000), after: "", binary: false } as T;
    }, "abc");
    expect(diffs).toBe(2);
    expect(text.length).toBe(MAX_CHANGES_TEXT);
    expect(text.endsWith("[commit truncated]")).toBe(true);
    const many = await commitChanges(async <T,>(method: string) =>
      (method === "git.show" ? { commit, files } : { diff: "d", after: "", binary: false }) as T, "abc");
    expect(many.endsWith("10 more changed files omitted")).toBe(true);
  });
});
