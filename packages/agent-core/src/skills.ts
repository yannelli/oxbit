import type { AgentCommand, AgentTool, CommandContext, CommandProvider, ContextProvider, Params, SessionView, ToolProvider } from "./extensions.js";
import { ancestors, escapeXml, findGitRoot, joinPath, parentPath, type HostFiles } from "./instructions.js";

export type FrontmatterValue = string | boolean | string[] | Record<string, string>;
export interface Skill {
  name: string;
  description: string;
  /** Absolute path of SKILL.md. */
  path: string;
  dir: string;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** false for `disable-model-invocation: true`: left out of the catalog, and the skill tool does not load it. */
  model: boolean;
  /** false for `user-invocable: false`: no slash command. */
  user: boolean;
  /** Parsed from `allowed-tools`; not enforced. */
  allowedTools?: string[];
  hint?: string;
}
export interface SkillSet {
  skills: Skill[];
  warnings: string[];
}
export interface SkillOptions {
  files: HostFiles;
  /** User skill directories in precedence order, for example ~/.oxbit/agent/skills, ~/.agents/skills, ~/.claude/skills. */
  roots: string[];
  /** Called on each use; true leaves the skill out of the catalog, the skill tool and the slash commands. */
  hidden?(name: string): boolean;
}

const KEY = /^([\w-]+):(?:[ \t]+(.*))?$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** a-z, 0-9 and single hyphens, 64 characters at most. */
export const isSkillName = (name: string) => name.length <= 64 && NAME.test(name);
const OUTPUT_LIMIT = 100000;
const scalar = (text: string): string | boolean => {
  const quoted = /^(["'])(.*)\1\s*(?:#.*)?$/s.exec(text);
  if (quoted?.[1] === '"') {
    try {
      return JSON.parse(`"${quoted[2]}"`);
    } catch {
      return quoted[2];
    }
  }
  if (quoted) return quoted[2].replace(/''/g, "'");
  const plain = text.replace(/(^|\s)#.*$/, "").trim();
  return /^(true|false)$/i.test(plain) ? plain.toLowerCase() === "true" : plain;
};
const fold = (lines: string[]) => lines.map((line) => line.trim())
  .reduce((text, line) => !line ? `${text}\n` : text && !text.endsWith("\n") ? `${text} ${line}` : text + line, "");
function value(inline: string, block: string[]): FrontmatterValue {
  const indent = Math.min(...block.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
  const lines = block.map((line) => line.slice(indent));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const style = /^([|>])[+-]?\d*[+-]?\s*(?:#.*)?$/.exec(inline);
  if (style) return style[1] === "|" ? lines.join("\n") : fold(lines);
  if (!inline && lines.length && lines.every((line) => !line.trim() || /^-(\s|$)/.test(line)))
    return lines.filter((line) => line.trim()).map((line) => String(scalar(line.slice(1).trim())));
  const pairs = inline ? [] : lines.filter((line) => line.trim()).map((line) => KEY.exec(line));
  if (pairs.length && pairs.every((pair) => pair)) return Object.fromEntries(pairs.map((pair) => [pair![1], String(scalar(pair![2]?.trim() ?? ""))]));
  if (inline.startsWith("[") && inline.endsWith("]"))
    return inline.slice(1, -1).split(",").map((item) => String(scalar(item.trim()))).filter((item) => item);
  return scalar(lines.length ? fold([inline, ...lines]) : inline);
}

/** YAML frontmatter between `---` lines: plain, quoted and block scalars, booleans, lists, and one level of string maps. */
export function parseFrontmatter(source: string): { data: Record<string, FrontmatterValue>; body: string } {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const lines = (match[1] ?? "").split("\n");
  const data: Record<string, FrontmatterValue> = {};
  for (let index = 0; index < lines.length; index++) {
    const key = KEY.exec(lines[index]);
    if (!key) continue;
    const block: string[] = [];
    while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || !lines[index + 1].trim())) block.push(lines[++index]);
    data[key[1]] = value(key[2]?.trim() ?? "", block);
  }
  return { data, body: text.slice(match[0].length) };
}

function toSkill(text: string, path: string, folder: string, warnings: string[]): Skill | undefined {
  const { data, body } = parseFrontmatter(text);
  const string = (key: string) => typeof data[key] === "string" ? (data[key] as string).trim() : "";
  const description = string("description");
  if (!description) {
    warnings.push(`${path}: skipped because the frontmatter has no description`);
    return undefined;
  }
  const name = string("name") || folder;
  if (!string("name")) warnings.push(`${path}: the frontmatter has no name, so the skill uses the directory name ${folder}`);
  if (!isSkillName(name)) warnings.push(`${path}: the name ${name} breaks the Agent Skills rules (a-z, 0-9 and single hyphens, 64 characters at most)`);
  else if (name !== folder) warnings.push(`${path}: the name ${name} differs from the directory name ${folder}`);
  if (description.length > 1024) warnings.push(`${path}: the description is longer than 1024 characters`);
  const tools = data["allowed-tools"];
  const hint = data["argument-hint"];
  return { name, description, path, dir: parentPath(path), body: body.trim(),
    model: data["disable-model-invocation"] !== true, user: data["user-invocable"] !== false,
    allowedTools: Array.isArray(tools) ? tools : typeof tools === "string" ? tools.split(/[\s,]+(?![^(]*\))/).filter((tool) => tool) : undefined,
    hint: Array.isArray(hint) ? `[${hint.join("] [")}]` : string("argument-hint") || undefined };
}

const clip = (text: string) => text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} characters]` : text;
/** Absolute path of a file inside the skill directory. Throws for paths that leave it. */
function bundledPath(dir: string, file: unknown) {
  if (typeof file !== "string" || !file || file.startsWith("/") || /[\0\\]/.test(file)) throw new Error("file must be a path relative to the skill directory");
  const parts: string[] = [];
  for (const part of file.split("/")) {
    if (part === ".." && !parts.length) throw new Error(`This path is outside the skill directory: ${file}`);
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  if (!parts.length) throw new Error("file must name a file in the skill directory");
  return joinPath(dir, parts.join("/"));
}
const wrap = (skill: Skill, body: string) => `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.path)}">\n`
  + `Bundled file paths are relative to ${skill.dir}. Read them with the skill tool's file parameter.\n\n${body}\n</skill>`;
/** The slash command prompt: the body with `$ARGUMENTS` replaced, else `ARGUMENTS: <args>` appended. */
export function invokeSkill(skill: Skill, args: string) {
  const placeholder = skill.body.includes("$ARGUMENTS");
  const text = wrap(skill, skill.body.replaceAll("$ARGUMENTS", () => args));
  return args && !placeholder ? `${text}\n\nARGUMENTS: ${args}` : text;
}

/** Agent Skills: the <available_skills> catalog, the `skill` tool, `/skills`, and a `/<name> args` command per skill. */
export class Skills implements ContextProvider, ToolProvider, CommandProvider {
  readonly label = "Skills";
  private sets = new Map<string, SkillSet>();
  constructor(private options: SkillOptions) {}
  /** Scans the user roots, then .agents/skills and .claude/skills from cwd up to the git root. The first skill with a name wins. */
  async discover(cwd: string): Promise<SkillSet> {
    const { files, roots } = this.options;
    const top = (await findGitRoot(files, cwd)) ?? cwd;
    const project = ancestors(cwd, top).flatMap((dir) => [joinPath(dir, ".agents/skills"), joinPath(dir, ".claude/skills")]);
    const set: SkillSet = { skills: [], warnings: [] };
    for (const root of [...new Set([...roots, ...project])]) {
      const entries = await files.list(root).catch(() => []);
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        const path = joinPath(joinPath(root, entry.name), "SKILL.md");
        if (entry.kind !== "directory" || !await files.exists(path)) continue;
        let text: string;
        try {
          text = await files.read(path);
        } catch (error) {
          set.warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const skill = toSkill(text, path, entry.name, set.warnings);
        const first = skill && set.skills.find((item) => item.name === skill.name);
        if (first) set.warnings.push(`${path}: the skill ${skill.name} is hidden by ${first.path}`);
        else if (skill) set.skills.push(skill);
      }
    }
    this.sets.set(cwd, set);
    return set;
  }
  private shown(skills: Skill[]) {
    return this.options.hidden ? skills.filter((skill) => !this.options.hidden!(skill.name)) : skills;
  }
  async system(session: SessionView) {
    const visible = this.shown((await this.discover(session.cwd)).skills).filter((skill) => skill.model);
    if (!visible.length) return undefined;
    return ["Skills hold instructions for specific tasks. When a task matches a skill's description, call the skill tool with its name before you act and follow the instructions it returns.",
      "<available_skills>",
      ...visible.map((skill) => `<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><location>${escapeXml(skill.path)}</location></skill>`),
      "</available_skills>"].join("\n");
  }
  async tools(session: SessionView): Promise<AgentTool[]> {
    const skills = this.shown((this.sets.get(session.cwd) ?? await this.discover(session.cwd)).skills);
    return skills.length ? [this.tool(skills)] : [];
  }
  private tool(skills: Skill[]): AgentTool {
    return {
      spec: { name: "skill", description: "Load a skill from <available_skills> by name. Returns its instructions and bundled files; with file, returns one bundled file.",
        parameters: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string" },
          file: { type: "string", description: "Bundled file path relative to the skill directory" } } } },
      kind: "read",
      title: (args) => `Skill ${args.name ?? ""}${args.file ? `: ${args.file}` : ""}`,
      run: async (args: Params) => {
        const skill = skills.find((item) => item.name === args.name);
        if (!skill) throw new Error(`Unknown skill ${args.name}. Skills: ${skills.filter((item) => item.model).map((item) => item.name).join(", ")}`);
        if (args.file !== undefined) return clip(await this.options.files.read(bundledPath(skill.dir, args.file)));
        if (!skill.model) throw new Error(`The skill ${skill.name} runs only when the user types /${skill.name}`);
        const files = await this.bundled(skill.dir);
        return clip(wrap(skill, skill.body) + (files.length ? `\n\nBundled files:\n${files.map((file) => `- ${file}`).join("\n")}` : ""));
      },
    };
  }
  /** Files under the skill directory except SKILL.md: 100 at most, 3 levels deep, without dot directories and node_modules. */
  private async bundled(dir: string) {
    const found: string[] = [];
    const walk = async (relative: string, depth: number) => {
      const entries = await this.options.files.list(relative ? joinPath(dir, relative) : dir).catch(() => []);
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (found.length >= 100) return;
        if (entry.kind === "file" && path !== "SKILL.md") found.push(path);
        else if (entry.kind === "directory" && depth < 3 && !entry.name.startsWith(".") && entry.name !== "node_modules") await walk(path, depth + 1);
      }
    };
    await walk("", 0);
    return found;
  }
  /** Synchronous, so it reads the last discovery; a session without one starts it and lists only `/skills`. */
  commands(session: SessionView): AgentCommand[] {
    const set = this.sets.get(session.cwd);
    if (!set) void this.discover(session.cwd).catch(() => {});
    const list: AgentCommand = { name: "skills", description: "List skills and skill warnings", run: (_args, context) => this.list(context) };
    return [list, ...this.shown(set?.skills ?? []).filter((skill) => skill.user && skill.name !== list.name).map((skill): AgentCommand => ({
      name: skill.name, description: skill.description.slice(0, 200), hint: skill.hint,
      run: async (args) => ({ prompt: invokeSkill(skill, args) }),
    }))];
  }
  private async list(context: CommandContext) {
    const { skills, warnings } = await this.discover(context.session.cwd);
    const lines = skills.length ? skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`) : ["No skills found."];
    if (warnings.length) lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
    context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: lines.join("\n") } });
    return { done: "end_turn" };
  }
}
