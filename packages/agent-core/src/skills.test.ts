import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { parentPath, type HostFiles } from "./instructions.js";
import { Skills, invokeSkill, parseFrontmatter } from "./skills.js";
import type { CommandContext, Params, SessionView } from "./extensions.js";
import { chatText } from "./test-models.js";
import { start, testHost, text } from "./test-host.js";

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
const skill = (front: string, body = "Steps") => `---\n${front}\n---\n${body}\n`;
const session = (cwd: string) => ({ id: "s", cwd, model: "m", turns: [], meta: {} }) as SessionView;
const ROOTS = ["/home/.oxbit/agent/skills", "/home/.agents/skills", "/home/.claude/skills"];
const FILES = {
  "/home/.oxbit/agent/skills/review/SKILL.md": skill("name: review\ndescription: Review <code> & tests", "Review $ARGUMENTS carefully"),
  "/home/.claude/skills/review/SKILL.md": skill("name: review\ndescription: Shadowed"),
  "/.agents/skills/outside/SKILL.md": skill("name: outside\ndescription: Above the repo"),
  "/repo/.git/HEAD": "ref",
  "/repo/.agents/skills/deploy/SKILL.md": skill("description: Deploy the app\nargument-hint: [env] [region]", "Run scripts/run.sh"),
  "/repo/.agents/skills/deploy/scripts/run.sh": "echo deploy",
  "/repo/.agents/skills/deploy/references/notes.md": "Notes",
  "/repo/.agents/skills/deploy/.cache/x": "hidden",
  "/repo/.claude/skills/bad/SKILL.md": skill("name: bad"),
  "/repo/.claude/skills/Bad_Name/SKILL.md": skill("name: Bad_Name\ndescription: Odd name"),
  "/repo/pkg/.claude/skills/lint/SKILL.md": skill("name: lint\ndescription: Lint\ndisable-model-invocation: true"),
  "/repo/pkg/.claude/skills/quiet/SKILL.md": skill("name: quiet\ndescription: Background facts\nuser-invocable: false"),
  "/repo/pkg/.claude/skills/notes.md": "not a skill",
};

describe("parseFrontmatter", () => {
  it("reads scalars, block scalars, booleans, lists and string maps", () => {
    const source = [
      "﻿---", "name: pdf-tools", "description: >-", "  Extract text from PDFs.", "  Use for PDF work.", "", "when_to_use: |", "  line one",
      "    indented", "disable-model-invocation: true", 'user-invocable: "false"', "allowed-tools:", "  - Read", '  - "Bash(git add:*)"',
      "argument-hint: '[file] [it''s]'", "metadata:", "  author: example-org", '  version: "1.0"', "# a comment", "license: MIT # inline",
      "tags: [a, \"b\"]", 'escaped: "a \\"b\\"\\n" # note', "plain: first", "  second", "empty:", "---", "# Body", ""].join("\r\n");
    expect(parseFrontmatter(source)).toEqual({ body: "# Body\n", data: {
      name: "pdf-tools", description: "Extract text from PDFs. Use for PDF work.", when_to_use: "line one\n  indented",
      "disable-model-invocation": true, "user-invocable": "false", "allowed-tools": ["Read", "Bash(git add:*)"], "argument-hint": "[file] [it's]",
      metadata: { author: "example-org", version: "1.0" }, license: "MIT", tags: ["a", "b"], escaped: 'a "b"\n', plain: "first second", empty: "" } });
  });
  it("returns the whole text as the body without frontmatter", () => {
    expect(parseFrontmatter("# Title\n---\nx")).toEqual({ data: {}, body: "# Title\n---\nx" });
    expect(parseFrontmatter("---\n---\nBody")).toEqual({ data: {}, body: "Body" });
  });
});

describe("Skills", () => {
  const files = memoryFiles(FILES);
  it("scans user roots, then project roots from cwd up to the git root, and records warnings", async () => {
    const { skills, warnings } = await new Skills({ files, roots: ROOTS }).discover("/repo/pkg");
    expect(skills.map((item) => item.name)).toEqual(["review", "lint", "quiet", "deploy", "Bad_Name"]);
    expect(skills[0]).toEqual(expect.objectContaining({ path: "/home/.oxbit/agent/skills/review/SKILL.md", dir: "/home/.oxbit/agent/skills/review", model: true, user: true }));
    expect(skills[1].model).toBe(false);
    expect(skills[2].user).toBe(false);
    expect(warnings).toEqual([
      "/home/.claude/skills/review/SKILL.md: the skill review is hidden by /home/.oxbit/agent/skills/review/SKILL.md",
      "/repo/.agents/skills/deploy/SKILL.md: the frontmatter has no name, so the skill uses the directory name deploy",
      "/repo/.claude/skills/bad/SKILL.md: skipped because the frontmatter has no description",
      "/repo/.claude/skills/Bad_Name/SKILL.md: the name Bad_Name breaks the Agent Skills rules (a-z, 0-9 and single hyphens, 64 characters at most)",
    ]);
  });
  it("lists model-invocable skills in an escaped <available_skills> catalog", async () => {
    const catalog = (await new Skills({ files, roots: ROOTS }).system(session("/repo/pkg")))!;
    expect(catalog).toContain("<skill><name>review</name><description>Review &lt;code&gt; &amp; tests</description><location>/home/.oxbit/agent/skills/review/SKILL.md</location></skill>");
    expect(catalog).toContain("<name>deploy</name>");
    expect(catalog).not.toContain("<name>lint</name>");
    expect(await new Skills({ files: memoryFiles({}), roots: ROOTS }).system(session("/w"))).toBeUndefined();
  });
  it("loads a skill body with its bundled files and reads files inside the skill directory only", async () => {
    const skills = new Skills({ files, roots: ROOTS });
    const [tool] = await skills.tools(session("/repo/pkg"));
    const run = (args: Params) => tool.run(args, {} as any);
    expect(tool.spec.name).toBe("skill");
    expect(await run({ name: "deploy" })).toBe('<skill name="deploy" location="/repo/.agents/skills/deploy/SKILL.md">\n'
      + "Bundled file paths are relative to /repo/.agents/skills/deploy. Read them with the skill tool's file parameter.\n\nRun scripts/run.sh\n</skill>"
      + "\n\nBundled files:\n- references/notes.md\n- scripts/run.sh");
    expect(await run({ name: "deploy", file: "./scripts/../scripts/run.sh" })).toBe("echo deploy");
    await expect(run({ name: "deploy", file: "../../skills/x" })).rejects.toThrow("outside the skill directory");
    await expect(run({ name: "deploy", file: "/etc/passwd" })).rejects.toThrow("relative to the skill directory");
    await expect(run({ name: "lint" })).rejects.toThrow("runs only when the user types /lint");
    await expect(run({ name: "nope" })).rejects.toThrow("Unknown skill nope");
    expect(await new Skills({ files: memoryFiles({}), roots: ROOTS }).tools(session("/w"))).toEqual([]);
  });
  it("adds a command per user-invocable skill after discovery and expands $ARGUMENTS", async () => {
    const skills = new Skills({ files, roots: ROOTS });
    expect(skills.commands(session("/repo/pkg")).map((command) => command.name)).toEqual(["skills"]);
    await skills.discover("/repo/pkg");
    const commands = skills.commands(session("/repo/pkg"));
    expect(commands.map((command) => command.name)).toEqual(["skills", "review", "lint", "deploy", "Bad_Name"]);
    expect(commands[3].hint).toBe("[env] [region]");
    const review = await commands[1].run("src/$&", {} as CommandContext);
    expect(review).toEqual({ prompt: expect.stringContaining("\n\nReview src/$& carefully\n</skill>") });
    expect((review as { prompt: string }).prompt).not.toContain("ARGUMENTS:");
    const [, , , deploy] = (await skills.discover("/repo/pkg")).skills;
    expect(invokeSkill(deploy, "prod now")).toMatch(/Run scripts\/run\.sh\n<\/skill>\n\nARGUMENTS: prod now$/);
    expect(invokeSkill(deploy, "")).toMatch(/<\/skill>$/);
  });
  it("prints skills and warnings for /skills", async () => {
    const updates: Params[] = [];
    const context = { session: session("/repo/pkg"), update: (update: Params) => updates.push(update) } as unknown as CommandContext;
    expect(await new Skills({ files, roots: ROOTS }).commands(session("/repo/pkg"))[0].run("", context)).toEqual({ done: "end_turn" });
    expect(updates[0].content.text).toMatch(/^- review: Review <code> & tests \(\/home\/\.oxbit\/agent\/skills\/review\/SKILL\.md\)\n/);
    expect(updates[0].content.text).toContain("\n\nWarnings:\n- /home/.claude/skills/review/SKILL.md: the skill review is hidden by");
  });
  it("runs through the agent: catalog in the system prompt, skill tool, and /name expansion", async () => {
    const skills = new Skills({ files: memoryFiles({ "/root/.git/HEAD": "", "/root/.agents/skills/deploy/SKILL.md": skill("name: deploy\ndescription: Deploy it") }), roots: [] });
    await skills.discover("/root");
    const t = testHost([chatText("Deployed")], { extensions: { context: [skills], tools: [skills], commands: [skills] } });
    const agent = new Agent(t.host);
    await agent.prompt(await start(agent), text("/deploy prod"));
    const body = t.posts()[0].body as any;
    expect(body.messages[0].content).toContain("<available_skills>\n<skill><name>deploy</name>");
    expect(body.messages[1].content).toMatch(/^<skill name="deploy" location="\/root\/\.agents\/skills\/deploy\/SKILL\.md">[\s\S]*ARGUMENTS: prod$/);
    expect(body.tools.map((tool: any) => tool.function.name)).toContain("skill");
  });
});
