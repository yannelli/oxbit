import { describe, expect, it } from "vitest";
import type { GitChange } from "@oxbit/sdk";
import { CommitPlanError, partiallyStaged, runCommitPlan } from "./plan-runner.js";

const changes: GitChange[] = [
  { path: "new.ts", originalPath: "old.ts", index: "R", working: " " },
  { path: "a.ts", index: " ", working: "M" },
  { path: "keep.txt", index: "M", working: " " },
  { path: "partial.txt", index: "M", working: "M" },
  { path: "loose.txt", index: "?", working: "?" },
];
const plan = [
  { message: "Rename", files: [{ path: "new.ts", originalPath: "old.ts" }] },
  { message: "Edit a", files: [{ path: "a.ts" }] },
];

function recorder(fail?: (method: string, params: Record<string, unknown>) => boolean) {
  const calls: [string, Record<string, unknown>?][] = [];
  const request = async <T,>(method: string, params?: Record<string, unknown>) => {
    calls.push(params ? [method, params] : [method]);
    if (fail?.(method, params ?? {})) throw new Error(`${method} failed`);
    return (method === "indexSnapshot" ? { tree: "a".repeat(40) } : {}) as T;
  };
  return { calls, request };
}

describe("commit plan runner", () => {
  it("stages rename sources with their destination and restores excluded entries from the snapshot", async () => {
    const { calls, request } = recorder();
    const steps: number[] = [];
    await runCommitPlan({ request, changes, plan, preserveIndex: true, step: (index) => steps.push(index) });
    expect(steps).toEqual([0, 1]);
    expect(calls).toEqual([
      ["indexSnapshot"],
      ["unstageAll"],
      ["stage", { path: "new.ts" }],
      ["stage", { path: "old.ts" }],
      ["commit", { message: "Rename" }],
      ["unstageAll"],
      ["stage", { path: "a.ts" }],
      ["commit", { message: "Edit a" }],
      ["indexRestore", { tree: "a".repeat(40), paths: ["keep.txt", "partial.txt", "loose.txt"] }],
    ]);
  });

  it("restores the snapshot for every uncommitted change when a commit fails", async () => {
    const { calls, request } = recorder((method, params) => method === "commit" && params.message === "Edit a");
    const failure = await runCommitPlan({ request, changes, plan, preserveIndex: true, step: () => {} }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CommitPlanError);
    expect(failure).toMatchObject({ index: 1, message: "commit failed" });
    expect(calls.at(-1)).toEqual([
      "indexRestore",
      { tree: "a".repeat(40), paths: ["a.ts", "keep.txt", "partial.txt", "loose.txt"] },
    ]);
  });

  it("stops before any commit when the snapshot fails", async () => {
    const { calls, request } = recorder((method) => method === "indexSnapshot");
    await expect(runCommitPlan({ request, changes, plan, preserveIndex: true, step: () => {} })).rejects.toThrow(
      "indexSnapshot failed",
    );
    expect(calls).toEqual([["indexSnapshot"]]);
  });

  it("reports a failed restore with the commit failure", async () => {
    const { request } = recorder((method) => method === "commit" || method === "indexRestore");
    await expect(runCommitPlan({ request, changes, plan, preserveIndex: true, step: () => {} })).rejects.toMatchObject({
      index: 0,
      message: "commit failed; indexRestore failed",
    });
  });

  it("stages previously staged files again on hosts without a snapshot, also after a failure", async () => {
    const { calls, request } = recorder((method) => method === "commit");
    await expect(runCommitPlan({ request, changes, plan, preserveIndex: false, step: () => {} })).rejects.toBeInstanceOf(
      CommitPlanError,
    );
    expect(calls).toEqual([
      ["unstageAll"],
      ["stage", { path: "new.ts" }],
      ["stage", { path: "old.ts" }],
      ["commit", { message: "Rename" }],
      ["unstageAll"],
      ["stage", { path: "new.ts" }],
      ["stage", { path: "old.ts" }],
      ["stage", { path: "keep.txt" }],
      ["stage", { path: "partial.txt" }],
    ]);
  });

  it("marks files with staged and unstaged edits as partially staged", () => {
    expect(changes.filter(partiallyStaged).map((change) => change.path)).toEqual(["partial.txt"]);
  });
});
