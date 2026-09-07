import { describe, expect, it, vi } from "vitest";
import type { FileEntry, FileSystem } from "@zapp/sdk";
import { findWorkspaceFiles, workspaceEntries } from "./files.js";

function fixture() {
  const directory = (path: string): FileEntry => ({
    path,
    name: path.split("/").at(-1)!,
    kind: "directory",
  });
  const file = (path: string): FileEntry => ({
    path,
    name: path.split("/").at(-1)!,
    kind: "file",
  });
  const tree: Record<string, FileEntry[]> = {
    "": [directory("closed"), directory("empty"), directory("node_modules")],
    closed: [file("closed/needle.ts")],
    empty: [],
    node_modules: [file("node_modules/dependency.js")],
  };
  const list = vi.fn(async (path = "") => tree[path]!);
  return { list, filesystem: { list } as unknown as FileSystem };
}
describe("explicit workspace traversal", () => {
  it("searches collapsed directories only for a nonempty query, without reading file contents", async () => {
    const { filesystem, list } = fixture();
    const signal = new AbortController().signal;
    expect(await findWorkspaceFiles(filesystem, "", signal)).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    expect(await findWorkspaceFiles(filesystem, "ndl", signal)).toEqual([
      "closed/needle.ts",
    ]);
    expect(list.mock.calls.map(([path]) => path)).not.toContain("node_modules");
  });
  it("stops traversing when the search is cancelled", async () => {
    const { filesystem, list } = fixture();
    const controller = new AbortController();
    list.mockImplementationOnce(async () => {
      controller.abort();
      return [];
    });
    await expect(
      findWorkspaceFiles(filesystem, "needle", controller.signal),
    ).rejects.toThrow();
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("exports entries in collapsed folders and empty directories", async () => {
    const { filesystem } = fixture();
    const entries = [];
    for await (const entry of workspaceEntries(filesystem))
      entries.push(entry.path);
    expect(entries).toEqual([
      "closed",
      "empty",
      "node_modules",
      "closed/needle.ts",
      "node_modules/dependency.js",
    ]);
  });
});
