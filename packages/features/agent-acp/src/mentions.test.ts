import { describe, expect, it } from "vitest";
import type { FileEntry, FileSystem } from "@oxbit/sdk";
import { insertMention, mentionQuery, rankFiles, searchFiles, searchSymbols, type WorkspaceSymbolSource } from "./mentions.js";

describe("mentions", () => {
  it("finds the @ token that ends at the caret", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("explain @src/ma", 15)).toEqual({ start: 8, query: "src/ma" });
    expect(mentionQuery("explain @src/main.ts please", 12)).toEqual({ start: 8, query: "src" });
    expect(mentionQuery("mail me@example.com", 19)).toBeUndefined();
    expect(mentionQuery("@done ", 6)).toBeUndefined();
    expect(mentionQuery("line\n@rea", 9)).toEqual({ start: 5, query: "rea" });
  });
  it("replaces the token with the chosen path", () => {
    expect(insertMention("see @rea", 4, 8, "README.md")).toEqual({ value: "see @README.md ", caret: 15 });
    expect(insertMention("see @re now", 4, 7, "README.md")).toEqual({ value: "see @README.md now", caret: 15 });
    expect(insertMention("see @remainder", 4, 6, "README.md")).toEqual({ value: "see @README.md ", caret: 15 });
  });
  it("ranks basename prefixes first and drops non-matches", () => {
    expect(rankFiles(["src/deep/main.ts", "docs/domain.md", "main.ts", "lib/other.ts"], "main"))
      .toEqual(["main.ts", "src/deep/main.ts", "docs/domain.md"]);
  });
  it("walks the workspace when the host has no file index", async () => {
    const tree: Record<string, FileEntry[]> = {
      "": [
        { path: "node_modules", name: "node_modules", kind: "directory" },
        { path: "src", name: "src", kind: "directory" },
        { path: "hello.txt", name: "hello.txt", kind: "file" },
      ],
      src: [{ path: "src/hello.ts", name: "hello.ts", kind: "file" }],
      node_modules: [{ path: "node_modules/hello.js", name: "hello.js", kind: "file" }],
    } as any;
    const filesystem = { list: async (path = "") => tree[path] ?? [] } as unknown as FileSystem;
    expect(await searchFiles(filesystem, "hello", new AbortController().signal)).toEqual(["hello.txt", "src/hello.ts"]);
    expect(await searchFiles(filesystem, " ", new AbortController().signal)).toEqual([]);
    const indexed = { findFiles: async () => ["a/zz-hello.ts", "hello.md"] } as unknown as FileSystem;
    expect(await searchFiles(indexed, "hello", new AbortController().signal)).toEqual(["hello.md", "a/zz-hello.ts"]);
  });
  it("maps workspace symbols to 1-based workspace lines and skips URIs outside the workspace", async () => {
    const service = {
      path(uri: string) {
        if (!uri.startsWith("file:///workspace/")) throw new Error("Language server URI outside workspace");
        return uri.slice("file:///workspace/".length);
      },
    };
    const range = (start: number, end: number) => ({ start: { line: start, character: 0 }, end: { line: end, character: 1 } });
    const language: WorkspaceSymbolSource = {
      async workspaceSymbols(query) {
        return [
          { service, target: { uri: "file:///workspace/src/login.ts", range: range(3, 9), name: `${query}Login` } },
          { service, target: { uri: "file:///elsewhere/lib.d.ts", range: range(0, 0), name: "handleOther" } },
          { service, target: { uri: "file:///workspace/src/user.ts", range: range(0, 0), name: "handleUser" } },
        ];
      },
    };
    const signal = new AbortController().signal;
    expect(await searchSymbols(language, "handle", signal)).toEqual([
      { kind: "symbol", name: "handleLogin", path: "src/login.ts", line: 4, endLine: 10 },
      { kind: "symbol", name: "handleUser", path: "src/user.ts", line: 1, endLine: 1 },
    ]);
    expect(await searchSymbols(language, "handle", signal, 1)).toHaveLength(1);
    expect(await searchSymbols(language, "h", signal)).toEqual([]);
    expect(await searchSymbols(undefined, "handle", signal)).toEqual([]);
  });
});
