import { it, expect } from "vitest";
import { searchText, replaceMatch, globMatch } from "./engine";
it("searches Unicode offsets and excludes paths", () => {
  expect(
    searchText("src/a.ts", "🐱 one\none", "r", {
      query: "one",
      wholeWord: true,
    }),
  ).toMatchObject([
    { from: 3, to: 6, line: 1, column: 4 },
    { from: 7, to: 10, line: 2, column: 1 },
  ]);
  expect(globMatch("src/a.ts", "**/*.ts")).toBe(true);
  expect(
    searchText("src/a.ts", "one", "r", { query: "one", exclude: "*.ts" }),
  ).toEqual([]);
});
it("previews capture replacements", () => {
  expect(
    replaceMatch(
      "one 12",
      4,
      6,
      { query: "(\\d)(\\d)", regex: true },
      "$2$1 $$",
    ),
  ).toBe("21 $");
});
