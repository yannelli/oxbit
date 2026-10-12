import { describe, expect, test } from "vitest";
import { markdownToAnsi } from "./markdown.js";
import { parseBlocks, parseInline, stableLength, tailLines } from "./markdown-parse.js";
import { stripAnsi, width } from "./width.js";

const render = (text: string, columns = 80) => stripAnsi(markdownToAnsi(text, columns));

describe("markdown", () => {
  test("parses blocks", () => {
    expect(parseBlocks("# Title\n\ntext\nmore\n\n- a\n  - b\n1. c\n\n> quote\n\n---").map((block) => block.type))
      .toEqual(["heading", "paragraph", "list", "quote", "rule"]);
    expect(parseBlocks("- [x] done\n- [ ] open")[0]).toMatchObject({ items: [{ checked: true, text: "done" }, { checked: false, text: "open" }] });
    expect(parseBlocks("1. a\n1. b\n1. c")[0]).toMatchObject({ items: [{ marker: "1." }, { marker: "2." }, { marker: "3." }] });
    expect(parseBlocks("Title\n===")[0]).toEqual({ type: "heading", level: 1, text: "Title" });
  });

  test("parses inline styles and leaves unmatched markers literal", () => {
    expect(parseInline("a **b** *c* `d` ~~e~~ [f](https://x.y) snake_case_name")).toEqual([
      { text: "a " }, { text: "b", bold: true }, { text: " " }, { text: "c", italic: true }, { text: " " }, { text: "d", code: true },
      { text: " " }, { text: "e", strike: true }, { text: " " }, { text: "f", link: "https://x.y" }, { text: " snake_case_name" }]);
    expect(parseInline("half **open")).toEqual([{ text: "half **open" }]);
    expect(parseInline("see https://example.com/a.")).toEqual([{ text: "see " }, { text: "https://example.com/a", link: "https://example.com/a" }, { text: "." }]);
  });

  test("renders headings, lists, code fences with a gutter and label, quotes and links", () => {
    const out = render("# Title\n\n- one\n  - two\n\n```ts\nconst a = 1;\n```\n\n> quoted\n\n[docs](https://d.example)");
    expect(out).toContain("Title");
    expect(out).toContain("• one");
    expect(out).toContain("  ◦ two");
    expect(out).toContain("╭─ typescript\n│ const a = 1;\n╰─");
    expect(out).toContain("┃ quoted");
    expect(out).toContain("docs (https://d.example)");
  });

  test("renders tables with aligned columns and wide characters", () => {
    const out = render("| Name | Count |\n|---|---:|\n| 世界 | 1 |\n| 👍 ok | 22 |");
    const lines = out.split("\n");
    expect(lines[0]).toBe("┌───────┬───────┐");
    expect(lines[1]).toBe("│ Name  │ Count │");
    expect(lines[3]).toBe("│ 世界  │     1 │");
    expect(lines[4]).toBe("│ 👍 ok │    22 │");
    expect(new Set(lines.filter(Boolean).map(width)).size).toBe(1);
  });

  test("falls back to a list when a table cannot fit", () => {
    const out = render(`| ${Array.from({ length: 12 }, (_, index) => `c${index}`).join(" | ")} |\n|${"---|".repeat(12)}\n| ${Array(12).fill("v").join(" | ")} |`, 30);
    expect(out).toContain("c0: v");
    for (const line of out.split("\n")) expect(width(line)).toBeLessThanOrEqual(30);
  });

  test("renders an unclosed fence while streaming", () => {
    const out = render("Intro\n\n```py\ndef f():\n    return 1");
    expect(out).toContain("╭─ python\n│ def f():\n│     return 1");
    expect(out).not.toContain("╰─");
  });

  test("finds the stable prefix outside code fences", () => {
    expect(stableLength("para one\n\npara two")).toBe("para one\n\n".length);
    expect(stableLength("```\na\n\nb")).toBe(0);
    expect(stableLength("```\na\n```\nrest")).toBe("```\na\n```\n".length);
    expect(stableLength("\n\nonly")).toBe(0);
  });

  test("keeps the tail of long text and reopens a cut fence", () => {
    const text = ["```js", ...Array.from({ length: 10 }, (_, index) => `line${index}`)].join("\n");
    expect(tailLines(text, 3)).toEqual({ text: "```js\nline7\nline8\nline9", hidden: 8 });
  });
});
