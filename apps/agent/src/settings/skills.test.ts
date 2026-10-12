import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuthStore } from "../auth.js";
import { panelContext, testSetup } from "../testing.js";
import { createSettingsManager } from "./index.js";

describe("skills panel", () => {
  it("creates and imports skills, refuses overwrites, and turns skills off", async () => {
    const t = await testSetup([]);
    const manager = createSettingsManager({ config: t.config, auth: new FileAuthStore(t.config.paths.auth), env: {}, home: t.home, provider: () => t.setup.provider });
    const context = panelContext(t.root);
    const path = join(t.config.paths.skills, "release-notes", "SKILL.md");
    expect(await manager.act("skills", "new", "new", ["release-notes", "Write release notes\nfrom commits"], context)).toEqual({ message: `Created ${path}` });
    expect(await readFile(path, "utf8")).toBe("---\nname: release-notes\ndescription: \"Write release notes from commits\"\n---\n\n# release-notes\n\nWrite the steps for this skill here.\n");
    await expect(manager.act("skills", "new", "new", ["release-notes", "Again"], context)).rejects.toThrow("already exists");
    await expect(manager.act("skills", "new", "new", ["Release_Notes", "Bad"], context)).rejects.toThrow("a-z, 0-9 and single hyphens");
    await expect(manager.act("skills", "new", "new", ["empty", " "], context)).rejects.toThrow("Add a description");

    await mkdir(join(t.root, "review", "references"), { recursive: true });
    await writeFile(join(t.root, "review", "SKILL.md"), "---\nname: review\ndescription: Review a change\n---\nSteps");
    await writeFile(join(t.root, "review", "references", "checklist.md"), "- tests");
    expect(await manager.act("skills", "import", "import", ["review"], context)).toEqual({ message: `Imported review into ${join(t.config.paths.skills, "review")}` });
    expect(await readFile(join(t.config.paths.skills, "review", "references", "checklist.md"), "utf8")).toBe("- tests");
    await expect(manager.act("skills", "import", "import", [join(t.root, "review")], context)).rejects.toThrow("already exists");
    await mkdir(join(t.root, "empty"));
    await expect(manager.act("skills", "import", "import", ["empty"], context)).rejects.toThrow("has no SKILL.md");
    await mkdir(join(t.home, ".claude", "skills", "broken"), { recursive: true });
    await writeFile(join(t.home, ".claude", "skills", "broken", "SKILL.md"), "---\nname: broken\n---\n");

    const rows = (await manager.panel("skills", context)).rows;
    expect(rows.map((row) => [row.id, row.detail, row.enabled, row.actions?.map((action) => action.id)])).toEqual([
      ["skill:release-notes", "Write release notes from commits", true, ["use"]], ["skill:review", "Review a change", true, ["use"]],
      ["new", "Creates ~/skills/<name>/SKILL.md", undefined, ["new"]], ["import", "Copies a folder with SKILL.md into ~/skills", undefined, ["import"]],
      ["warning:0", undefined, undefined, undefined]]);
    expect(rows.at(-1)!.label).toContain("broken/SKILL.md: skipped because the frontmatter has no description");
    expect(await manager.act("skills", "skill:review", "use", [], context)).toEqual({ draft: "/review " });
    await manager.toggle("skills", "skill:review", false, context);
    expect(JSON.parse(await readFile(t.config.paths.settings, "utf8"))).toEqual({ disabledSkills: ["review"] });
    const off = (await manager.panel("skills", context)).rows[1];
    expect([off.enabled, off.actions]).toEqual([false, undefined]);
  });
});
