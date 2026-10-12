import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasRipgrep, nodeFilesystem, walkFiles } from "./fs.js";
import { IgnoreRules, globFilter } from "./ignore.js";
import { tempDir } from "./testing.js";

async function tree(files: Record<string, string>) {
  const root = await tempDir("oxa-tree-");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

describe("gitignore rules", () => {
  it("matches names at any depth, anchored paths, directories and negations", () => {
    const rules = new IgnoreRules().with("*.log\n!keep.log\n/build\ndist/\n# comment\ndocs/**/*.tmp\n", "");
    expect(rules.ignores("a/b/c.log", false)).toBe(true);
    expect(rules.ignores("a/keep.log", false)).toBe(false);
    expect(rules.ignores("build", true)).toBe(true);
    expect(rules.ignores("src/build", true)).toBe(false);
    expect(rules.ignores("dist", true)).toBe(true);
    expect(rules.ignores("dist", false)).toBe(false);
    expect(rules.ignores("docs/a/b/x.tmp", false)).toBe(true);
    expect(rules.with("*.txt", "sub").ignores("sub/x.txt", false)).toBe(true);
    expect(rules.with("*.txt", "sub").ignores("x.txt", false)).toBe(false);
  });

  it("filters include globs by name or path", () => {
    expect(globFilter("*.ts")!("src/a.ts")).toBe(true);
    expect(globFilter("src/**/*.ts,*.md")!("lib/a.ts")).toBe(false);
    expect(globFilter("src/**/*.{ts,tsx}")!("src/x/a.tsx")).toBe(true);
    expect(globFilter("")).toBeUndefined();
  });
});

describe("nodeFilesystem", () => {
  const files = {
    ".gitignore": "out/\n*.secret\n", "src/a.ts": "const needle = 1;\n", "src/sub/.gitignore": "gen.ts\n", "src/sub/gen.ts": "needle\n",
    "src/sub/b.ts": "no match\nNEEDLE again\n", "out/x.ts": "needle\n", "key.secret": "needle\n", "node_modules/m/index.js": "needle\n",
  };

  it("walks files that git would keep", async () => {
    expect(await walkFiles(await tree(files))).toEqual([".gitignore", "src/a.ts", "src/sub/.gitignore", "src/sub/b.ts"]);
  });

  it("searches without rg, honoring .gitignore, case and include globs", async () => {
    const filesystem = nodeFilesystem(await tree(files), { ripgrep: false });
    const result = await filesystem.search!({ query: "needle" });
    expect(result.matches.map((match) => `${match.path}:${match.line}:${match.column}`)).toEqual(["src/a.ts:1:7", "src/sub/b.ts:2:1"]);
    expect((await filesystem.search!({ query: "needle", caseSensitive: true })).matches).toHaveLength(1);
    expect((await filesystem.search!({ query: "n[e]+dle", regex: true, include: "sub/*.ts" })).matches).toEqual([]);
    expect((await filesystem.search!({ query: "n[e]+dle", regex: true, include: "src/sub/*.ts" })).matches.map((match) => match.path)).toEqual(["src/sub/b.ts"]);
    expect(await filesystem.findFiles!("sb")).toEqual(["src/sub/.gitignore", "src/sub/b.ts"]);
  });

  it("searches with rg when it is on PATH", async (context) => {
    if (!await hasRipgrep()) return context.skip();
    const result = await nodeFilesystem(await tree({ "a.ts": "x needle\n", "b.md": "needle\n" })).search!({ query: "needle", include: "*.ts" });
    expect(result.matches).toEqual([expect.objectContaining({ path: "a.ts", line: 1, column: 3, from: 2, to: 8, text: "x needle" })]);
  });

  it("lists one directory, directories first, without .git", async () => {
    const root = await tree({ "b.txt": "", "a/x.txt": "", ".git/HEAD": "" });
    expect((await nodeFilesystem(root).list()).map((entry) => `${entry.kind}:${entry.path}`)).toEqual(["directory:a", "file:b.txt"]);
    expect((await nodeFilesystem(root).list("a")).map((entry) => entry.path)).toEqual(["a/x.txt"]);
    await expect(nodeFilesystem(root).list("../")).rejects.toThrow("outside the workspace");
  });
});
