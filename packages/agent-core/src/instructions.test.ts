import { describe, expect, it } from "vitest";
import { FILE_LIMIT, Instructions, ancestors, findGitRoot, parentPath, type HostFiles } from "./instructions.js";
import type { SessionView } from "./extensions.js";

function memoryFiles(files: Record<string, string>): HostFiles {
  const dirs = new Set<string>();
  for (const path of Object.keys(files))
    for (let dir = parentPath(path); ; dir = parentPath(dir)) {
      dirs.add(dir);
      if (dir === "/") break;
    }
  return {
    exists: async (path) => path in files || dirs.has(path),
    read: async (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    list: async (dir) => {
      const prefix = dir === "/" ? "/" : `${dir}/`;
      const entries = new Map<string, "file" | "directory">();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        entries.set(rest.split("/")[0], rest.includes("/") ? "directory" : "file");
      }
      return [...entries].map(([name, kind]) => ({ name, kind }));
    },
  };
}
const session = (cwd: string) => ({ id: "s", cwd, model: "m", turns: [], meta: {} }) as SessionView;

describe("paths", () => {
  it("walks from a directory up to an ancestor and finds the git root from a .git file or directory", async () => {
    expect(ancestors("/a/b/c", "/a")).toEqual(["/a/b/c", "/a/b", "/a"]);
    expect(ancestors("/a/b", "/")).toEqual(["/a/b", "/a", "/"]);
    expect(ancestors("/a/b", "/x")).toEqual(["/a/b"]);
    expect(await findGitRoot(memoryFiles({ "/repo/.git/HEAD": "ref", "/repo/a/b.ts": "" }), "/repo/a")).toBe("/repo");
    expect(await findGitRoot(memoryFiles({ "/wt/.git": "gitdir: /repo/.git/worktrees/wt" }), "/wt")).toBe("/wt");
    expect(await findGitRoot(memoryFiles({ "/tmp/x/a.ts": "" }), "/tmp/x")).toBeUndefined();
  });
});

describe("Instructions", () => {
  const files = memoryFiles({
    "/home/.oxbit/agent/AGENTS.md": "Global rules",
    "/home/.claude/CLAUDE.md": "Claude user rules",
    "/AGENTS.md": "Above the repo",
    "/repo/.git/HEAD": "ref",
    "/repo/AGENTS.md": "Root agents",
    "/repo/CLAUDE.md": "Root claude",
    "/repo/a/AGENTS.override.md": "Override",
    "/repo/a/AGENTS.md": "A agents",
    "/repo/a/b/CLAUDE.md": "B claude",
    "/repo/a/b/c/AGENTS.md": "  \n",
  });
  it("loads global files, then one file per directory from the git root down to cwd", async () => {
    const instructions = new Instructions({ files, global: "/home/.oxbit/agent/AGENTS.md", claude: "/home/.claude/CLAUDE.md", append: "Be brief." });
    expect((await instructions.load("/repo/a/b/c")).map((file) => file.path)).toEqual([
      "/home/.oxbit/agent/AGENTS.md", "/home/.claude/CLAUDE.md", "/repo/AGENTS.md", "/repo/a/AGENTS.override.md", "/repo/a/b/CLAUDE.md"]);
    const text = await instructions.system(session("/repo/a/b/c"));
    expect(text).toMatch(/^Instructions from AGENTS\.md and CLAUDE\.md files\./);
    expect(text).toContain('<instructions path="/repo/AGENTS.md">\nRoot agents\n</instructions>\n\n<instructions path="/repo/a/AGENTS.override.md">');
    expect(text!.endsWith("</instructions>\n\nBe brief.")).toBe(true);
    expect(text).not.toContain("Above the repo");
  });
  it("leaves out ~/.claude/CLAUDE.md unless its path is passed, and reads only cwd outside a repository", async () => {
    expect((await new Instructions({ files, global: "/home/.oxbit/agent/AGENTS.md" }).load("/repo")).map((file) => file.path))
      .toEqual(["/home/.oxbit/agent/AGENTS.md", "/repo/AGENTS.md"]);
    const loose = memoryFiles({ "/tmp/AGENTS.md": "Parent", "/tmp/x/AGENTS.md": "Here" });
    expect((await new Instructions({ files: loose }).load("/tmp/x")).map((file) => file.path)).toEqual(["/tmp/x/AGENTS.md"]);
  });
  it("lists missing global files as candidates and skips files in the system prompt", async () => {
    const instructions = new Instructions({ files, global: "/home/.oxbit/agent/AGENTS.md", claude: "/home/.claude/missing.md",
      skip: (path) => path === "/repo/AGENTS.md" });
    expect((await instructions.candidates("/repo/a")).map(({ path, scope, text }) => [path, scope, text])).toEqual([
      ["/home/.oxbit/agent/AGENTS.md", "global", "Global rules"], ["/home/.claude/missing.md", "claude", undefined],
      ["/repo/AGENTS.md", "project", "Root agents"], ["/repo/a/AGENTS.override.md", "project", "Override"]]);
    const text = await instructions.system(session("/repo/a"));
    expect(text).toContain("Global rules");
    expect(text).toContain("Override");
    expect(text).not.toContain("Root agents");
  });
  it("returns the append alone, or nothing when there is no text", async () => {
    const empty = memoryFiles({});
    expect(await new Instructions({ files: empty }).system(session("/w"))).toBeUndefined();
    expect(await new Instructions({ files: empty, append: " Use tabs. " }).system(session("/w"))).toBe("Use tabs.");
  });
  it("caps each file at 32 KiB and the total at 64 KiB on character boundaries", async () => {
    const kib = (size: number) => "x".repeat(size * 1024);
    const capped = memoryFiles({ "/r/.git/HEAD": "", "/r/AGENTS.md": "é".repeat(20000), "/r/a/AGENTS.md": kib(30),
      "/r/a/b/AGENTS.md": kib(30), "/r/a/b/c/AGENTS.md": "last" });
    const text = (await new Instructions({ files: capped }).system(session("/r/a/b/c")))!;
    const sections = text.split("<instructions path=").slice(1);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toContain(`${"é".repeat(FILE_LIMIT / 2)}\n[Truncated at ${FILE_LIMIT} bytes]`);
    expect(sections[0]).not.toContain("�");
    expect(sections[1]).toContain(kib(30));
    expect(sections[2]).toContain(`${"x".repeat(2048)}\n[Truncated at 2048 bytes]`);
    expect(text).toMatch(/\[Skipped 1 more instruction files: the 64 KiB limit is reached\]$/);
  });
});
