import { describe, expect, it } from "vitest";
import {
  BrowserFileSystem,
  MemoryPersistence,
  decodeText,
  encodeText,
} from "./index";

describe("browser filesystem", () => {
  it("serializes concurrent writes and rejects stale revisions", async () => {
    const filesystem = new BrowserFileSystem(new MemoryPersistence());
    const snapshot = await filesystem.write("file.txt", "before", {
      expectedRevision: null,
    });
    const results = await Promise.allSettled([
      filesystem.write("file.txt", "first", {
        expectedRevision: snapshot.revision,
      }),
      filesystem.write("file.txt", "second", {
        expectedRevision: snapshot.revision,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
  it("imports, lists, renames and exports files and empty directories", async () => {
    const filesystem = new BrowserFileSystem(new MemoryPersistence());
    await filesystem.import({
      files: [{ path: "src/index.ts", text: "hello" }],
      directories: ["empty"],
    });
    expect((await filesystem.list()).map((entry) => entry.path)).toEqual([
      "empty",
      "src",
    ]);
    await filesystem.rename("src", "lib");
    expect((await filesystem.read("lib/index.ts")).text).toBe("hello");
    const archive = await filesystem.export();
    expect(archive.files[0]?.path).toBe("lib/index.ts");
    expect(archive.directories).toContain("empty");
    await filesystem.delete("lib");
    expect(await filesystem.list()).toEqual([
      { path: "empty", name: "empty", kind: "directory" },
    ]);
  });
  it("rejects invalid archives without applying earlier entries", async () => {
    const filesystem = new BrowserFileSystem(new MemoryPersistence());
    await expect(
      filesystem.import({
        files: [
          { path: "valid.txt", text: "okay" },
          { path: "../escape", text: "bad" },
        ],
      }),
    ).rejects.toThrow("Invalid workspace path");
    expect(await filesystem.list()).toHaveLength(0);
    await expect(
      filesystem.write("/absolute.txt", "", { expectedRevision: null }),
    ).rejects.toThrow("Invalid workspace path");
  });
  it("round-trips Unicode, BOMs and line endings and rejects lossy conversion", () => {
    for (const encoding of ["utf-8", "utf-8-bom", "utf-16le"] as const) {
      const bytes = encodeText("你好 👩🏽‍💻\nnext", encoding, "CRLF");
      const result = decodeText(bytes);
      expect(result.text).toBe("你好 👩🏽‍💻\nnext");
      expect(result.encoding).toBe(encoding);
      expect(result.eol).toBe("CRLF");
    }
    expect(decodeText(encodeText("café", "latin1"), "latin1").text).toBe(
      "café",
    );
    expect(() => encodeText("你好", "latin1")).toThrow("cannot encode");
    expect(() => encodeText("\ud800", "utf-8")).toThrow("surrogate");
    expect(() => decodeText(new Uint8Array([0xc0, 0xaf]))).toThrow(
      "Invalid utf-8",
    );
    expect(() => decodeText(new Uint8Array([0xfe, 0xff, 0, 65]))).toThrow(
      "UTF-16BE",
    );
  });
});
