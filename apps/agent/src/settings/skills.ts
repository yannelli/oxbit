import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isSkillName, parseFrontmatter } from "@oxbit/agent-core";
import { stringList } from "../config.js";
import { skillsFor } from "../extensions.js";
import { readOptional } from "../mcp.js";
import type { PanelChange, PanelRow } from "../tui/connection.js";
import { firstLine, setListed, tilde, unknownRow, userHome, warningRows, type PanelHandler, type SettingsDeps } from "./shared.js";

const exists = (path: string) => stat(path).then(() => true, () => false);
const skillName = (rowId: string) => rowId.startsWith("skill:") ? rowId.slice("skill:".length) : undefined;

/** `~/x` from the home, other relative paths from `cwd`. */
export const expandPath = (input: string, cwd: string, home: string) =>
  resolve(cwd, input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input);

async function newSkill({ config }: SettingsDeps, name: string, description: string): Promise<PanelChange> {
  const summary = description.replace(/\s+/g, " ").trim();
  if (!isSkillName(name)) throw new Error("Use a skill name with a-z, 0-9 and single hyphens, 64 characters at most");
  if (!summary) throw new Error("Add a description: what the skill does and when to use it");
  if (summary.length > 1024) throw new Error("The description is longer than 1024 characters");
  const dir = join(config.paths.skills, name);
  if (await exists(dir)) throw new Error(`${dir} already exists`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeFile(path, `---\nname: ${name}\ndescription: ${JSON.stringify(summary)}\n---\n\n# ${name}\n\nWrite the steps for this skill here.\n`, { flag: "wx" });
  return { message: `Created ${path}` };
}

async function importSkill(deps: SettingsDeps, input: string, cwd: string): Promise<PanelChange> {
  if (!input.trim()) throw new Error("Enter the path of a folder that contains SKILL.md");
  const source = expandPath(input.trim(), cwd, userHome(deps));
  const text = await readOptional(join(source, "SKILL.md"));
  if (text === undefined) throw new Error(`${source} has no SKILL.md`);
  const description = parseFrontmatter(text).data.description;
  if (typeof description !== "string" || !description.trim()) throw new Error(`${join(source, "SKILL.md")} has no description in its frontmatter`);
  const target = join(deps.config.paths.skills, basename(source));
  if (await exists(target)) throw new Error(`${target} already exists`);
  await mkdir(deps.config.paths.skills, { recursive: true });
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  return { message: `Imported ${basename(source)} into ${target}` };
}

export const skillsPanel: PanelHandler = {
  async panel(deps, { cwd }) {
    const home = userHome(deps);
    const { skills, warnings } = await skillsFor(deps.config, home).discover(cwd);
    const hidden = new Set(stringList(deps.config.settings.disabledSkills));
    const rows: PanelRow[] = skills.map((skill) => {
      const enabled = !hidden.has(skill.name);
      return { id: `skill:${skill.name}`, section: "Skills", label: skill.name, detail: firstLine(skill.description, 120) || tilde(skill.path, home), enabled,
        ...enabled && skill.user ? { actions: [{ id: "use", label: `Use /${skill.name}` }] } : {} };
    });
    if (!rows.length) rows.push({ id: "none", section: "Skills", label: "No skills found" });
    const folder = tilde(deps.config.paths.skills, home);
    rows.push(
      { id: "new", section: "Add", label: "New skill", detail: `Creates ${folder}/<name>/SKILL.md`, actions: [{ id: "new", label: "New skill",
        inputs: [{ label: "Name", placeholder: "release-notes" }, { label: "Description", placeholder: "What the skill does and when to use it" }] }] },
      { id: "import", section: "Add", label: "Import a skill folder", detail: `Copies a folder with SKILL.md into ${folder}`, actions: [{ id: "import",
        label: "Import", inputs: [{ label: "Folder with SKILL.md", placeholder: "~/Downloads/review" }] }] },
      ...warningRows(warnings));
    return { id: "skills", title: "Skills", rows, footer: "Unchecked skills leave the catalog, the skill tool and the slash commands." };
  },
  async toggle({ config }, rowId, enabled) {
    const name = skillName(rowId);
    if (!name) throw unknownRow(rowId);
    await setListed(config, "disabledSkills", name, !enabled);
    return { message: `${name} is ${enabled ? "on" : "off"}` };
  },
  async act(deps, rowId, actionId, inputs, { cwd }) {
    if (rowId === "new" && actionId === "new") return newSkill(deps, inputs[0]?.trim() ?? "", inputs[1] ?? "");
    if (rowId === "import" && actionId === "import") return importSkill(deps, inputs[0] ?? "", cwd);
    const name = skillName(rowId);
    if (name && actionId === "use") return { draft: `/${name} ` };
    throw unknownRow(`${rowId} ${actionId}`);
  },
};
