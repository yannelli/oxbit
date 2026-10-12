import { join } from "node:path";
import { readJson, stringList, writeJson, type AgentConfig } from "../config.js";
import { projectTrusted } from "../mcp.js";
import type { PanelChange, PanelRow } from "../tui/connection.js";
import { setListed, tilde, unknownRow, userHome, type PanelHandler } from "./shared.js";

type Entry = Record<string, unknown>;
const NAME = /^[\w-]+$/;
const isObject = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);

/** Words of a command line: whitespace splits, single quotes keep text as is, double quotes and backslashes escape. */
export function splitCommandLine(line: string) {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === "\"" && index + 1 < line.length) word += line[++index];
      else word += char;
    } else if (char === "\"" || char === "'") [quote, started] = [char, true];
    else if (char === "\\" && index + 1 < line.length) [word, started] = [word + line[++index], true];
    else if (/\s/.test(char)) {
      if (started) words.push(word);
      [word, started] = ["", false];
    } else [word, started] = [word + char, true];
  }
  if (quote) throw new Error("The command line has an unclosed quote");
  if (started) words.push(word);
  return words;
}

/** `{type: "http", url}` for an http(s) URL, else a stdio entry from the command line. */
export function serverEntry(input: string): Entry {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    if (!URL.canParse(text)) throw new Error(`Invalid URL: ${text}`);
    return { type: "http", url: text };
  }
  const [command, ...args] = splitCommandLine(text);
  if (!command) throw new Error("Enter a URL or a command line");
  return { command, args };
}

const describe = (entry: unknown) => {
  if (!isObject(entry)) return "invalid entry";
  const off = entry.enabled === false || entry.disabled === true ? ", off in the file" : "";
  if (typeof entry.url === "string") return `${typeof entry.type === "string" ? entry.type : "http"} ${entry.url}${off}`;
  const args = Array.isArray(entry.args) ? entry.args.filter((arg) => typeof arg === "string") : [];
  return `stdio ${[entry.command, ...args].join(" ")}${off}`;
};

async function servers(path: string) {
  try {
    const body = await readJson<unknown>(path, {});
    const entries = isObject(body) && isObject(body.mcpServers) ? body.mcpServers : {};
    return { body: isObject(body) ? body : {}, entries };
  } catch (error) {
    return { body: {}, entries: {}, error: (error as Error).message };
  }
}
async function writeServers(config: AgentConfig, change: (entries: Entry) => void) {
  const { body, entries, error } = await servers(config.paths.mcp);
  if (error) throw new Error(error);
  const next = { ...entries };
  change(next);
  await writeJson(config.paths.mcp, { ...body, mcpServers: next }, 0o600);
}

export const mcpPanel: PanelHandler = {
  async panel(deps, { cwd }) {
    const { config } = deps;
    const home = userHome(deps);
    const disabled = new Set(stringList(config.settings.disabledMcpServers));
    const user = await servers(config.paths.mcp);
    const projectPath = join(cwd, ".mcp.json");
    const project = await servers(projectPath);
    const trust = await projectTrusted(config.paths.settings, cwd) ? "this folder is trusted" : "this folder is not trusted; turn on Project MCP servers in /config";
    const rows: PanelRow[] = [
      ...Object.entries(user.entries).map(([name, entry]) => ({ id: `user:${name}`, section: `User · ${tilde(config.paths.mcp, home)}`, label: name,
        detail: describe(entry), enabled: !disabled.has(name), actions: [{ id: "remove", label: "Remove" }] })),
      ...Object.entries(project.entries).map(([name, entry]) => ({ id: `project:${name}`, section: `Project · ${tilde(projectPath, home)}`, label: name,
        detail: `${describe(entry)} · ${trust}`, enabled: !disabled.has(name) })),
      { id: "add", section: "Add", label: "Add server", detail: `Saved in ${tilde(config.paths.mcp, home)}`, actions: [{ id: "add", label: "Add server",
        inputs: [{ label: "Name", placeholder: "github" }, { label: "URL or command line", placeholder: "https://example.com/mcp or npx -y @scope/server" }] }] },
      ...[user.error, project.error].filter((error) => !!error).map((error, index) => ({ id: `warning:${index}`, section: "Warnings", label: error! })),
    ];
    return { id: "mcp", title: "MCP servers", rows, footer: "Changes apply on the next turn." };
  },
  async toggle({ config }, rowId, enabled) {
    const name = /^(?:user|project):(.+)$/.exec(rowId)?.[1];
    if (!name) throw unknownRow(rowId);
    await setListed(config, "disabledMcpServers", name, !enabled);
    return { message: `${name} is ${enabled ? "on" : "off"} from the next turn` };
  },
  async act({ config }, rowId, actionId, inputs): Promise<PanelChange> {
    if (rowId === "add" && actionId === "add") {
      const name = inputs[0]?.trim() ?? "";
      if (!NAME.test(name)) throw new Error("Use a server name with letters, digits, - and _");
      const entry = serverEntry(inputs[1] ?? "");
      await writeServers(config, (entries) => {
        if (name in entries) throw new Error(`${config.paths.mcp} already has a server named ${name}`);
        entries[name] = entry;
      });
      return { message: `Added ${name}; it connects on the next turn` };
    }
    const name = rowId.startsWith("user:") ? rowId.slice("user:".length) : undefined;
    if (!name || actionId !== "remove") throw unknownRow(`${rowId} ${actionId}`);
    await writeServers(config, (entries) => {
      if (!(name in entries)) throw new Error(`${config.paths.mcp} has no server named ${name}`);
      delete entries[name];
    });
    return { message: `Removed ${name}` };
  },
};
