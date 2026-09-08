import { describe, expect, it } from "vitest";
import { lspGlobMatches, lspWatchPattern } from "./lsp-glob.js";
describe("LSP glob dialect", () => {
  it.each([
    ["**/*.{ts,tsx}", "main.ts", true], ["**/*.{ts,tsx}", "nested/main.tsx", true], ["**/*.{ts,tsx}", "main.js", false],
    ["src/[a-z]?.ts", "src/az.ts", true], ["src/[!0-9]*.ts", "src/a.ts", true], ["src/[!0-9]*.ts", "src/1.ts", false],
    ["*.ts", "src/main.ts", false], ["**/config.{json,{toml,yaml}}", "a/config.yaml", true],
    ["a[1].ts", "a1.ts", true], ["[!a]", "/", false], ["{broken", "broken", false], ["[broken", "broken", false],
  ])("matches %s against %s", (pattern, file, expected) => expect(lspGlobMatches(pattern, file)).toBe(expected));
});

it("bounds relative and absolute watcher patterns to the authorized root", () => {
  expect(lspWatchPattern({ baseUri: "file:///workspace/src", pattern: "**/*.{ts,tsx}" }, "file:///workspace")).toBe("src/**/*.{ts,tsx}");
  expect(lspWatchPattern({ baseUri: { uri: "file:///workspace", name: "Workspace" }, pattern: "*.json" }, "file:///workspace")).toBe("*.json");
  expect(lspWatchPattern("/workspace/**/*.ts", "file:///workspace")).toBe("**/*.ts");
  for (const pattern of ["/outside/*.ts", "../*.ts", { baseUri: "file:///outside", pattern: "*.ts" }, { baseUri: "file:///workspace/../outside", pattern: "*.ts" }]) expect(lspWatchPattern(pattern, "file:///workspace")).toBeUndefined();
});
