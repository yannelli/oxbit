import { MODES, type PermissionMode } from "@oxbit/agent-core";
import type { ACPConfigOption } from "@oxbit/sdk";
import { stringList, type AgentConfig, type AgentSettings } from "../config.js";
import type { ExtensionSettings } from "../extensions.js";
import { projectTrusted } from "../mcp.js";
import type { PanelChange, PanelRow } from "../tui/connection.js";
import { setListed, unknownRow, type PanelHandler } from "./shared.js";

const PERCENTS = [50, 60, 70, 80, 90];
const MODE_OPTIONS = MODES.map(({ id, name }) => ({ value: id, name }));
const ON_OFF = [{ value: "on", name: "On" }, { value: "off", name: "Off" }];
/** Checkbox rows that map to one boolean in settings.json. */
export const FLAGS: Record<string, { key: keyof ExtensionSettings | "trustProjectMcp"; label: string; detail: string; on?: boolean }> = {
  "auto-compact": { key: "autoCompact", label: "Auto-compact", detail: "Summarize the conversation when the context window fills", on: true },
  "claude-instructions": { key: "claudeInstructions", label: "Load ~/.claude/CLAUDE.md", detail: "After the global AGENTS.md" },
  "claude-hooks": { key: "claudeHooks", label: "Claude hooks", detail: "~/.claude/settings.json and the project's .claude settings files" },
  "codex-hooks": { key: "codexHooks", label: "Codex hooks", detail: "~/.codex/hooks.json and the project's .codex/hooks.json" },
  "all-project-mcp": { key: "trustProjectMcp", label: "MCP servers in every project", detail: "Run .mcp.json servers without trusting each folder" },
};

export const flagOn = (config: AgentConfig, id: string) => {
  const flag = FLAGS[id];
  return flag.on ? config.settings[flag.key] !== false : config.settings[flag.key] === true;
};
export const flagRow = (config: AgentConfig, id: string, section: string): PanelRow =>
  ({ id, section, label: FLAGS[id].label, detail: FLAGS[id].detail, enabled: flagOn(config, id) });
export async function setFlag(config: AgentConfig, id: string, enabled: boolean): Promise<PanelChange> {
  await config.saveSettings({ [FLAGS[id].key]: enabled } as Partial<AgentSettings>);
  return { message: `${FLAGS[id].label} is ${enabled ? "on" : "off"}` };
}

/** "default" or the saved percent as text. */
export function compactAt(config: AgentConfig) {
  const value = config.settings.autoCompactAt;
  return typeof value === "number" && value >= 50 && value <= 95 ? String(value) : "default";
}
function compactOptions(config: AgentConfig) {
  const percents = [...new Set([...PERCENTS, Number(compactAt(config)) || 50])].sort((a, b) => a - b);
  return [{ value: "default", name: "Default" }, ...percents.map((percent) => ({ value: String(percent), name: `${percent}%` }))];
}
async function setCompactAt(config: AgentConfig, value: string): Promise<PanelChange> {
  const percent = value === "default" ? undefined : Number(value.replace(/%$/, ""));
  if (percent !== undefined && !(Number.isInteger(percent) && percent >= 50 && percent <= 95)) throw new Error("Compact at takes default or a percent from 50 to 95");
  await config.saveSettings({ autoCompactAt: percent });
  return { message: percent ? `Auto-compact starts at ${percent}% of the context window` : "Auto-compact uses the default threshold" };
}

export const configPanel: PanelHandler = {
  async panel({ config }, { cwd }) {
    const listed = stringList(config.settings.trustedProjects).includes(cwd);
    const trusted = await projectTrusted(config.paths.settings, cwd);
    const how = !trusted ? `Off for ${cwd}` : listed ? `Trusted: ${cwd}` : config.settings.trustProjectMcp === true
      ? "Trusted because MCP servers run in every project" : "Trusted through a parent folder";
    return { id: "config", title: "Config", rows: [
      { id: "mode", section: "Permissions", label: "Permission mode", detail: "Saved for new sessions and applied to this one",
        choice: { value: config.settings.mode ?? "ask", options: MODE_OPTIONS } },
      flagRow(config, "auto-compact", "Context"),
      { id: "compact-at", section: "Context", label: "Compact at", detail: "Share of the context window", choice: { value: compactAt(config), options: compactOptions(config) } },
      flagRow(config, "claude-instructions", "Instructions"),
      flagRow(config, "claude-hooks", "Hooks"),
      flagRow(config, "codex-hooks", "Hooks"),
      { id: "project-mcp", section: "MCP", label: "Project MCP servers for this folder", detail: how, enabled: trusted },
      flagRow(config, "all-project-mcp", "MCP"),
    ] };
  },
  async toggle({ config }, rowId, enabled, { cwd }) {
    if (rowId in FLAGS) return setFlag(config, rowId, enabled);
    if (rowId !== "project-mcp") throw unknownRow(rowId);
    await setListed(config, "trustedProjects", cwd, enabled);
    const still = !enabled && await projectTrusted(config.paths.settings, cwd);
    return { message: enabled ? `MCP servers in ${cwd}/.mcp.json run from the next turn`
      : still ? `Removed ${cwd}; this folder stays trusted through another setting` : `MCP servers in ${cwd}/.mcp.json are off` };
  },
  async choose({ config }, rowId, value) {
    if (rowId === "compact-at") return setCompactAt(config, value);
    if (rowId !== "mode") throw unknownRow(rowId);
    const mode = MODES.find((item) => item.id === value);
    if (!mode) throw new Error(`Unknown mode ${value}. Use one of: ${MODES.map((item) => item.id).join(", ")}`);
    await config.saveSettings({ mode: mode.id as PermissionMode });
    return { mode: mode.id, message: `Permission mode: ${mode.name}` };
  },
};

/** ACP session config options for auto-compact and its threshold, saved to settings.json. */
export function compactConfigOptions(config: AgentConfig) {
  return {
    configOptions: (): ACPConfigOption[] => [
      { id: "auto-compact", name: "Auto-compact", type: "select", currentValue: flagOn(config, "auto-compact") ? "on" : "off", options: ON_OFF },
      { id: "compact-at", name: "Compact at", type: "select", currentValue: compactAt(config), options: compactOptions(config) },
    ],
    async setConfigOption(configId: string, value: string) {
      if (configId === "auto-compact" && (value === "on" || value === "off")) await setFlag(config, "auto-compact", value === "on");
      else if (configId === "compact-at") await setCompactAt(config, value);
      else return false;
      return true;
    },
  };
}
