import { describe, expect, test } from "vitest";
import { accept, commandItems, commandToken, fileItems, fileToken } from "./complete.js";
import type { PermissionRequest } from "./connection.js";
import { diffLines } from "./diff.js";
import { backspace, cursorLines, deleteWordLeft, insert, left, vertical, type Draft } from "./editor.js";
import { highlight } from "./highlight.js";
import { outcomeOf, ruleKey } from "./permission.js";
import { resolveTheme } from "./theme.js";
import { truncate, width } from "./width.js";

describe("width", () => {
  test("counts wide characters, emoji and combining marks", () => {
    expect(width("abc")).toBe(3);
    expect(width("世界")).toBe(4);
    expect(width("👍🏽")).toBe(2);
    expect(width("é")).toBe(1);
    expect(width("\x1b[31mred\x1b[39m")).toBe(3);
    expect(truncate("世界世界", 5)).toBe("世界…");
  });
});

describe("editor", () => {
  test("edits by grapheme and moves between lines", () => {
    let draft: Draft = insert({ text: "", cursor: 0 }, "ab👍🏽");
    draft = backspace(draft);
    expect(draft).toEqual({ text: "ab", cursor: 2 });
    draft = insert(draft, "\ncdef");
    expect(vertical(draft, -1)).toEqual({ text: "ab\ncdef", cursor: 2 });
    expect(vertical(draft, 1)).toBeUndefined();
    expect(deleteWordLeft({ text: "one two", cursor: 7 })).toEqual({ text: "one ", cursor: 4 });
    expect(cursorLines(left({ text: "x\nyz", cursor: 4 }))).toEqual([{ before: "x" }, { before: "y", under: "z", after: "" }]);
  });
});

describe("completion", () => {
  const commands = [{ name: "compact", description: "c" }, { name: "goal", description: "g", hint: "<objective>" }, { name: "model", description: "m" }];
  test("ranks slash commands and replaces the token", () => {
    const draft = { text: "/co", cursor: 3 };
    const token = commandToken(draft)!;
    const items = commandItems(commands, token.query);
    expect(items.map((item) => item.value)).toEqual(["/compact"]);
    expect(accept(draft, { kind: "command", items, index: 0, ...token }, items[0])).toEqual({ text: "/compact ", cursor: 9 });
    expect(commandToken({ text: "/goal x", cursor: 7 })).toBeUndefined();
  });
  test("finds @ tokens and ranks file names before paths", () => {
    const draft = { text: "look at @log please", cursor: 12 };
    const token = fileToken(draft)!;
    expect(token).toEqual({ query: "log", start: 8, end: 12 });
    const items = fileItems(["docs/catalog.md", "src/login.ts", "src/auth/logout.ts"], token.query);
    expect(items.map((item) => item.label)).toEqual(["src/login.ts", "src/auth/logout.ts", "docs/catalog.md"]);
    expect(accept(draft, { kind: "file", items, index: 0, ...token }, items[0]).text).toBe("look at @src/login.ts please");
  });
});

describe("diff", () => {
  test("numbers changed lines and folds distant context", () => {
    const before = Array.from({ length: 20 }, (_, index) => `l${index + 1}`).join("\n");
    const after = before.replace("l10", "L10");
    const { lines, added, removed } = diffLines(before, after);
    expect({ added, removed }).toEqual({ added: 1, removed: 1 });
    expect(lines[0]).toEqual({ type: "gap", count: 6 });
    expect(lines).toContainEqual({ type: "removed", text: "l10", oldNo: 10 });
    expect(lines).toContainEqual({ type: "added", text: "L10", newNo: 10 });
    expect(lines.at(-1)).toEqual({ type: "gap", count: 7 });
    expect(diffLines(null, "a\nb\n")).toMatchObject({ added: 2, removed: 0 });
  });
});

describe("permission", () => {
  const request = (command: string, options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }]): PermissionRequest =>
    ({ sessionId: "s", options, toolCall: { toolCallId: "t", title: command, kind: "execute", rawInput: { command } } });
  test("maps decisions to ACP outcomes", () => {
    expect(ruleKey(request("npm test"))).toBe("execute:npm");
    expect(outcomeOf(request("npm test"), "session")).toEqual({ outcome: { outcome: { outcome: "selected", optionId: "allow" } }, remember: true });
    expect(outcomeOf(request("x"), "deny").outcome).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    const always = request("x", [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "once", name: "Once", kind: "allow_once" }]);
    expect(outcomeOf(always, "session")).toEqual({ outcome: { outcome: { outcome: "selected", optionId: "always" } }, remember: false });
  });
});

describe("theme and highlighting", () => {
  test("follows COLORFGBG", () => {
    expect(resolveTheme("auto", { COLORFGBG: "0;15" }).name).toBe("light");
    expect(resolveTheme("auto", { COLORFGBG: "15;0" }).name).toBe("dark");
    expect(resolveTheme("auto", {}).name).toBe("dark");
    expect(resolveTheme("light", {}).name).toBe("light");
  });
  test("tokenizes keywords, strings and comments", () => {
    expect(highlight(`const a = "x"; // note`, "ts")).toEqual([
      { text: "const", kind: "keyword" }, { text: " " }, { text: "a" }, { text: " = " }, { text: `"x"`, kind: "string" }, { text: "; " }, { text: "// note", kind: "comment" }]);
    expect(highlight("+added", "diff")).toEqual([{ text: "+added", kind: "added" }]);
  });
});
