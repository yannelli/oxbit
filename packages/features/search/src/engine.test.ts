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
it("keeps replacement tokens literal outside regex mode after validating the match", () => {
  const replacement = "$0 $1 $10 $<name> $$ $& $` $'";
  expect(replaceMatch("one two", 4, 7, { query: "two" }, replacement)).toBe(
    replacement,
  );
  expect(() =>
    replaceMatch("one new", 4, 7, { query: "two" }, replacement),
  ).toThrow("Search match changed");
});
it("expands unmatched optional captures without changing the replacement dialect", () => {
  expect(
    replaceMatch("b", 0, 1, { query: "(a)?b", regex: true }, "$0 $1X $2 $10"),
  ).toBe("b X $2 $10");
  expect(
    replaceMatch(
      "ab", 0, 2, { query: "(?<first>a)(b)", regex: true },
      "$0 $1 $2 $10 $<first> $<missing>",
    ),
  ).toBe("ab a b $10 a ");
  expect(
    replaceMatch(
      "abcdefghij", 0, 10,
      { query: "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)", regex: true },
      "$10",
    ),
  ).toBe("j");
});
