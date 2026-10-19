import { describe, expect, it } from "vitest";
import type { TextEdit } from "@oxbit/sdk";
import { lineEdits } from "./line-diff.js";

const apply = (text: string, edits: TextEdit[]) =>
  [...edits].reverse().reduce((result, edit) => result.slice(0, edit.from) + edit.insert + result.slice(edit.to), text);

describe("lineEdits", () => {
  it("keeps each formatter change on its own lines", () => {
    const before = "const a=1\nconst b = 2\nconst c = 3\nconst d=4\n";
    const after = "const a = 1;\nconst b = 2\nconst c = 3\nconst d = 4;\n";
    const edits = lineEdits(before, after);
    expect(edits).toEqual([
      { from: 7, to: 9, insert: " = 1;" },
      { from: 41, to: 43, insert: " = 4;" },
    ]);
    expect(apply(before, edits)).toBe(after);
  });

  it("handles inserted and removed lines, empty texts, and a missing final newline", () => {
    for (const [before, after] of [
      ["a\nb\nc", "a\nx\nb\nc\ny"],
      ["a\nb\nc\n", "c\n"],
      ["", "a\nb"],
      ["a\nb", ""],
      ["x", "x\n"],
    ])
      expect(apply(before, lineEdits(before, after))).toBe(after);
    expect(lineEdits("same\n", "same\n")).toEqual([]);
  });

  it("matches random edits", () => {
    let seed = 7;
    const random = (limit: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % limit;
    for (let round = 0; round < 200; round++) {
      const lines = Array.from({ length: random(30) }, () => `line ${random(8)}`);
      const changed = lines.flatMap((line) => random(4) === 0 ? [] : random(5) === 0 ? [line, `new ${random(9)}`] : [random(6) === 0 ? `${line}!` : line]);
      const before = lines.join("\n"), after = changed.join("\n") + (random(2) ? "\n" : "");
      expect(apply(before, lineEdits(before, after))).toBe(after);
    }
  });
});
