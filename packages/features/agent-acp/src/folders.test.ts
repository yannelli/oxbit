import { describe, expect, it } from "vitest";
import type { FileEntry, FileSystem } from "@oxbit/sdk";
import { MAX_FOLDER_FILES, folderText } from "./folders.js";

const file = (path: string, size?: number): FileEntry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", size });
const folder = (path: string): FileEntry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "directory" });
const workspace = (tree: Record<string, FileEntry[]>, texts: Record<string, string>) => ({
  list: async (path = "") => {
    if (!tree[path]) throw new Error(`Missing ${path}`);
    return tree[path];
  },
  read: async (path: string) => {
    if (!(path in texts)) throw new Error("Binary files are not supported");
    return { path, text: texts[path] };
  },
}) as unknown as FileSystem;

describe("folderText", () => {
  it("lists the folder's files and includes the text of those that fit", async () => {
    const filesystem = workspace({
      src: [file("src/b.ts"), folder("src/lib"), file("src/a.ts"), folder("src/node_modules"), file("src/logo.png"), file("src/big.txt", 500)],
      "src/lib": [file("src/lib/util.ts"), file("src/lib/raw.bin")],
      "src/node_modules": [file("src/node_modules/dep.js")],
    }, { "src/a.ts": "alpha", "src/b.ts": "beta", "src/lib/util.ts": "util", "src/lib/raw.bin": "a\0b", "src/big.txt": "x".repeat(500) });
    expect(await folderText(filesystem, "src", 400)).toBe([
      "Folder src: 6 files, 3 with their text below",
      "",
      "src/a.ts\nsrc/b.ts\nsrc/big.txt\nsrc/logo.png\nsrc/lib/raw.bin\nsrc/lib/util.ts",
      "",
      "--- src/a.ts\nalpha",
      "",
      "--- src/b.ts\nbeta",
      "",
      "--- src/lib/util.ts\nutil",
    ].join("\n"));
    await expect(folderText(filesystem, "missing")).rejects.toThrow("Missing missing");
    await expect(folderText(workspace({ empty: [] }, {}), "empty")).rejects.toThrow("empty has no files");
  });
  it("stops listing after the file cap", async () => {
    const files = Array.from({ length: MAX_FOLDER_FILES + 2 }, (_, index) => file(`many/f${String(index).padStart(4, "0")}`));
    const text = await folderText(workspace({ many: files }, {}), "many");
    expect(text.startsWith(`Folder many: ${MAX_FOLDER_FILES}+ files, 0 with their text below`)).toBe(true);
    expect(text).toContain(`[more than ${MAX_FOLDER_FILES} files]`);
    expect(text).not.toContain(`f${MAX_FOLDER_FILES}`);
  });
});
