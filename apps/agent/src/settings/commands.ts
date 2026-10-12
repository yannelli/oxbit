import { resolve } from "node:path";
import type { AgentCommand, CommandContext, CommandProvider, McpTools } from "@oxbit/agent-core";
import { SETTINGS_COMMANDS } from "../extensions.js";
import type { Panel, PanelChange, PanelContext, PanelId, PanelRow, SettingsManager } from "../tui/connection.js";

const HELP: Record<PanelId, { description: string; hint: string; usage: string[] }> = {
  config: { description: "Show or change agent settings", hint: "<setting> <value>", usage: [
    "`/config <setting> <value>`, for example `/config auto-compact off`, `/config compact-at 80` or `/config mode full-auto`"] },
  skills: { description: "List skills; turn one on or off, create one or import a folder", hint: "enable|disable|new|import ...", usage: [
    "`/skills enable <name|number>`, `/skills disable <name|number>`", "`/skills new <name> <description>`", "`/skills import <folder with SKILL.md>`"] },
  hooks: { description: "List command hooks and turn them on or off", hint: "enable|disable <number>", usage: [
    "`/hooks enable <number>`, `/hooks disable <number>`", "`/config claude-hooks on`, `/config codex-hooks on` load Claude Code and Codex hook files"] },
  mcp: { description: "Show MCP servers; add, remove, turn on or off, or reconnect them", hint: "add|remove|enable|disable|reload ...", usage: [
    "`/mcp add <name> <url or command line>`, `/mcp remove <name>`", "`/mcp enable <name>`, `/mcp disable <name>`", "`/mcp reload` reconnects the servers"] },
  instructions: { description: "List instruction files and the global prompt", hint: "enable|disable|prompt ...", usage: [
    "`/instructions enable <number|path>`, `/instructions disable <number|path>`", "`/instructions prompt <text>` sets the global prompt; without text it clears it"] },
  providers: { description: "List model providers; pick one, or sign in or out of ChatGPT", hint: "use|enable|disable|login|signout ...", usage: [
    "`/providers use <id>` saves the provider for the next start", "`/providers enable <id>`, `/providers disable <id>` for automatic selection",
    "`/providers login chatgpt`, `/providers signout`", "API keys: run `oxbit-agent login --provider <id>` in a terminal, or use /providers in the oxbit-agent terminal UI"] },
};
const ON = new Set(["on", "true", "yes", "enable", "enabled", "1"]);
const OFF = new Set(["off", "false", "no", "disable", "disabled", "0"]);
const split = (text: string): [string, string] => {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? [match[1], match[2]?.trim() ?? ""] : ["", ""];
};

function rowText(row: PanelRow, keys: boolean) {
  const box = row.enabled === undefined ? "" : row.enabled ? "[x] " : "[ ] ";
  const choice = row.choice ? `: ${row.choice.value} (${row.choice.options.map((option) => option.value).join(", ")})` : "";
  return `${box}${row.label}${keys ? ` \`${row.id}\`` : ""}${choice}${row.detail ? ` · ${row.detail}` : ""}`;
}
/** The panel as markdown: sections in bold and rows numbered across the panel. */
export function panelText(panel: Panel, usage: string[], keys = false) {
  const lines = [`## ${panel.title}`];
  let section: string | undefined;
  panel.rows.forEach((row, index) => {
    if (row.section !== section && (section = row.section)) lines.push("", `**${section}**`);
    lines.push(`${index + 1}. ${rowText(row, keys)}`);
  });
  if (panel.footer) lines.push("", panel.footer);
  lines.push("", "**Usage**", ...usage.map((line) => `- ${line}`));
  return lines.join("\n");
}

/** A row by its number in the listing, its ID, the name after `scope:`, its label, or a path from cwd. */
function findRow(panel: Panel, key: string, cwd: string) {
  const rows = panel.rows;
  const found = /^\d+$/.test(key) ? rows[Number(key) - 1] : rows.find((row) => row.id === key) ?? rows.find((row) => row.id.endsWith(`:${key}`))
    ?? rows.find((row) => row.label.toLowerCase() === key.toLowerCase()) ?? rows.find((row) => row.id === resolve(cwd, key));
  if (!found) throw new Error(`No ${key} in ${panel.title}. Run /${panel.id} to list them.`);
  return found;
}
const switchOf = (value: string) => {
  const word = value.toLowerCase();
  if (ON.has(word)) return true;
  if (OFF.has(word)) return false;
  throw new Error(`Use on or off, not ${value || "nothing"}`);
};

export interface McpStatus { tools: McpTools["tools"]; report: McpTools["report"]; close: McpTools["close"] }

/** /config, /skills, /hooks, /mcp, /instructions and /providers as agent commands over the settings panels, for ACP clients. */
export function settingsCommands(manager: SettingsManager, mcp?: McpStatus): CommandProvider {
  const say = (context: CommandContext, text: string) => context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const panelContext = (context: CommandContext): PanelContext =>
    ({ cwd: context.session.cwd, sessionId: context.session.id, signal: context.signal, progress: (text) => say(context, `${text}\n\n`) });
  const applied = (change: PanelChange, context: CommandContext) => {
    if (change.mode) {
      context.session.meta.mode = change.mode;
      context.update({ sessionUpdate: "current_mode_update", currentModeId: change.mode });
    }
    return [change.message, change.draft && `Type ${change.draft.trim()} to use it.`].filter((part) => !!part).join("\n") || "Done";
  };
  const status = async (context: CommandContext, reload: boolean) => {
    if (!mcp) return "";
    if (reload) await mcp.close(context.session.id);
    await mcp.tools(context.session);
    return mcp.report(context.session.id);
  };

  async function run(id: PanelId, args: string, context: CommandContext) {
    const at = panelContext(context);
    const panel = () => manager.panel(id, at);
    const toggle = async (key: string, enabled: boolean) => applied(await manager.toggle(id, findRow(await panel(), key, at.cwd).id, enabled, at), context);
    const act = async (rowId: string, actionId: string, inputs: string[] = []) => applied(await manager.act(id, rowId, actionId, inputs, at), context);
    const [verb, rest] = split(args);
    const word = verb.toLowerCase();
    if (!verb) return [id === "mcp" ? await status(context, false) : "", panelText(await panel(), HELP[id].usage, id === "config" || id === "providers")]
      .filter((part) => !!part).join("\n\n");
    if (word === "enable" || word === "disable") return toggle(rest, word === "enable");
    if (id === "config") {
      const row = findRow(await panel(), verb, at.cwd);
      if (row.choice) {
        const value = row.choice.options.find((option) => [option.value, option.name].some((name) => name.toLowerCase() === rest.toLowerCase().replace(/%$/, "")));
        return applied(await manager.choose(id, row.id, value?.value ?? rest, at), context);
      }
      if (row.enabled === undefined) throw new Error(`${row.label} has no on or off setting`);
      return applied(await manager.toggle(id, row.id, switchOf(rest), at), context);
    }
    if (id === "skills" && word === "new") return act("new", "new", split(rest));
    if (id === "skills" && word === "import") return act("import", "import", [rest]);
    if (id === "instructions" && word === "prompt") return act("prompt", "edit", [rest]);
    if (id === "mcp" && word === "add") return act("add", "add", split(rest));
    if (id === "mcp" && word === "remove") return act(`user:${rest}`, "remove");
    if (id === "mcp" && word === "reload") return status(context, true);
    if (id === "providers" && word === "use") return act(findRow(await panel(), rest, at.cwd).id, "use");
    if (id === "providers" && word === "signout") return act("openai", "signout");
    if (id === "providers" && word === "login" && rest.toLowerCase() === "chatgpt") return act("openai", "chatgpt");
    throw new Error(`Unknown /${id} command. Usage:\n${HELP[id].usage.map((line) => `- ${line}`).join("\n")}`);
  }

  const commands = SETTINGS_COMMANDS.map((id): AgentCommand => ({ name: id, description: HELP[id].description, hint: HELP[id].hint,
    run: async (args, context) => {
      let text: string;
      try {
        text = await run(id, args, context);
      } catch (error) {
        if (context.signal.aborted) return { done: "cancelled" };
        text = error instanceof Error ? error.message : String(error);
      }
      say(context, text);
      return { done: "end_turn" };
    } }));
  return { commands: () => commands };
}
