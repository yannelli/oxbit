import { describe, expect, it } from "vitest";
import { MAX_CHANGES_TEXT, uncommittedChanges } from "./changes.js";

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
