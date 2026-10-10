import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceFiles } from "../src/filesystem.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("protected filesystem descendants", () => {
  it("rejects renaming and deleting ancestors through their real paths or aliases", async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-protected-"));
    roots.push(root);
    const privateRoot = path.join(root, ".oxbit", "runtime");
    await fs.mkdir(privateRoot, { recursive: true });
    await fs.writeFile(path.join(privateRoot, "runtime.json"), "private state");
    await fs.symlink(".oxbit", path.join(root, "alias"));
    const files = new WorkspaceFiles(root, privateRoot);

    for (const parent of [".oxbit", "alias"]) {
      await expect(files.rename(parent, "moved")).rejects.toMatchObject({ code: "PATH_DENIED" });
      await expect(files.delete(parent)).rejects.toMatchObject({ code: "PATH_DENIED" });
    }
    await expect(files.read(".oxbit/runtime/runtime.json")).rejects.toMatchObject({ code: "PATH_DENIED" });
    expect(await fs.readFile(path.join(privateRoot, "runtime.json"), "utf8")).toBe("private state");
    await expect(fs.stat(path.join(root, "moved"))).rejects.toMatchObject({ code: "ENOENT" });

    await fs.mkdir(path.join(root, ".oxbit", "ordinary"));
    await files.rename(".oxbit/ordinary", ".oxbit/renamed");
    await files.delete(".oxbit/renamed");
    expect(await files.list(".oxbit")).toEqual([]);
  });

  it("protects containing directories before a configured private file exists", async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-protected-file-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "preferences"));
    const files = new WorkspaceFiles(root);
    files.protect(path.join(root, "preferences", "settings.json"));
    await expect(files.rename("preferences", "renamed")).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(files.delete("preferences")).rejects.toMatchObject({ code: "PATH_DENIED" });
  });
});
