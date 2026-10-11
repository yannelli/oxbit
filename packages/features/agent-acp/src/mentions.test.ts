import { describe, expect, it } from "vitest";
import type { FileEntry, FileSystem } from "@oxbit/sdk";
import type { Conversation } from "./history.js";
import {
  insertMention, mentionQuery, rankFiles, searchFiles, searchSymbols, searchThreads, threadTranscript, type WorkspaceSymbolSource,
} from "./mentions.js";

const conversation = (id: string, title: string, extra: Partial<Conversation> = {}): Conversation => ({
  id, sessionId: id, root: "/workspace", provider: "codex", title, updatedAt: "2026-10-10T12:00:00.000Z",
  draft: "", context: [], activity: [], tools: [], ...extra,
});

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
  it("finds saved threads by title in the connected root, newest first, without the open one", () => {
    const entries = [
      conversation("open", "Fix login redirect"),
      conversation("newer", "Login form copy", { name: "Claude Agent" }),
      conversation("other-root", "Login elsewhere", { root: "/other" }),
      conversation("older", "Refactor LOGIN service"),
      conversation("unrelated", "Update docs"),
    ];
    expect(searchThreads(entries, "login", { exclude: "open", root: "/workspace" })).toEqual([
      { kind: "thread", id: "newer", title: "Login form copy", agent: "Claude Agent", updatedAt: "2026-10-10T12:00:00.000Z" },
      { kind: "thread", id: "older", title: "Refactor LOGIN service", agent: "Codex ACP", updatedAt: "2026-10-10T12:00:00.000Z" },
    ]);
    expect(searchThreads(entries, "login").map((thread) => thread.id)).toEqual(["open", "newer", "other-root", "older"]);
    expect(searchThreads(entries, "login", {}, 1)).toHaveLength(1);
    expect(searchThreads(entries, " ")).toEqual([]);
  });
  it("formats a thread's user and agent messages and keeps the latest text within the limit", () => {
    const entry = conversation("thread", "Fix login", {
      activity: [
        { kind: "message", message: { role: "user", text: "Why does login fail?" } },
        { kind: "message", message: { role: "thought", text: "private reasoning" } },
        { kind: "tool", id: "read-1" },
        { kind: "message", message: { role: "agent", text: "The token expired. " } },
        { kind: "notice", text: "Disconnected" },
      ],
    });
    expect(threadTranscript(entry)).toBe(
      "Earlier conversation with Codex ACP: Fix login\n\nUser: Why does login fail?\n\nAgent: The token expired.",
    );
    const trimmed = threadTranscript(entry, 70);
    expect(trimmed).toHaveLength(70);
    expect(trimmed.startsWith("Earlier conversation with Codex ACP: Fix login\n\n")).toBe(true);
    expect(trimmed.endsWith("The token expired.")).toBe(true);
    expect(threadTranscript(conversation("empty", "Nothing"))).toBe("");
  });
});
