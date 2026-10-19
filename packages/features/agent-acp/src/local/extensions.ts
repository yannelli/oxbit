import { Compaction, Instructions, MODES, Skills, controlExtensions, findFiles, workspaceFiles, type AgentCommand, type AgentExtensions, type CommandContext,
  type Params, type PermissionMode, type SessionStore } from "@oxbit/agent-core";
import type { ACPConfigOption, FileSystem } from "@oxbit/sdk";
import { COMPACT_PERCENTS, OXBIT_COMPACT_SETTINGS, OXBIT_INSTRUCTIONS_SETTING } from "../configuration.js";
type Configuration = { get<T>(id: string): T | undefined; set(id: string, value: unknown, scope?: any): unknown };

const ON_OFF = [{ value: "on", name: "On" }, { value: "off", name: "Off" }];
const say = (context: CommandContext, text: string) => context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

/** Compaction settings as ACP config options and the `/config` command. */
export function compactSettings(configuration: Configuration) {
  const auto = () => configuration.get<boolean>(OXBIT_COMPACT_SETTINGS.auto) !== false;
  const at = () => {
    const value = String(configuration.get(OXBIT_COMPACT_SETTINGS.at) ?? "");
    return COMPACT_PERCENTS.includes(value) ? value : "default";
  };
  const options = (): ACPConfigOption[] => [
    { id: "auto-compact", name: "Auto-compact", type: "select", currentValue: auto() ? "on" : "off", options: ON_OFF },
    { id: "compact-at", name: "Compact at", type: "select", currentValue: at(),
      options: [{ value: "default", name: "Default" }, ...COMPACT_PERCENTS.map((value) => ({ value, name: `${value}%` }))] },
  ];
  async function set(configId: string, value: string) {
    const word = value.trim().toLowerCase().replace(/%$/, "");
    if (configId === "auto-compact" && (word === "on" || word === "off"))
      await configuration.set(OXBIT_COMPACT_SETTINGS.auto, word === "on", "user");
    else if (configId === "compact-at" && (word === "default" || COMPACT_PERCENTS.includes(word)))
      await configuration.set(OXBIT_COMPACT_SETTINGS.at, word, "user");
    else return false;
    return true;
  }
  const compaction = new Compaction({
    get auto() {
      return auto();
    },
    get percent() {
      const value = Number(at());
      return Number.isFinite(value) ? value : undefined;
    },
  });
  const config: AgentCommand = {
    name: "config", description: "Show or change agent settings", hint: "<setting> <value>",
    run: async (args, context) => {
      const [setting = "", value = ""] = args.trim().split(/\s+/, 2);
      const mode = MODES.find((item) => item.id === context.session.meta.mode) ?? MODES[0];
      if (!setting) {
        say(context, ["## Config", `1. Permission mode \`mode\`: ${mode.id} (${MODES.map((item) => item.id).join(", ")})`,
          `2. Auto-compact \`auto-compact\`: ${auto() ? "on" : "off"} (on, off)`, `3. Compact at \`compact-at\`: ${at()} (default, ${COMPACT_PERCENTS.join(", ")})`,
          "", "Usage: `/config <setting> <value>`, for example `/config auto-compact off`, `/config compact-at 80` or `/config mode full-auto`."].join("\n"));
      } else if (setting === "mode") {
        const next = MODES.find((item) => item.id === value);
        if (!next) say(context, `Unknown mode ${value || "(none)"}. Use one of: ${MODES.map((item) => item.id).join(", ")}`);
        else {
          context.session.meta.mode = next.id as PermissionMode;
          context.update({ sessionUpdate: "current_mode_update", currentModeId: next.id });
          say(context, `Permission mode: ${next.name}`);
        }
      } else if (await set(setting, value)) {
        say(context, setting === "auto-compact" ? `Auto-compact is ${auto() ? "on" : "off"}`
          : at() === "default" ? "Auto-compact uses the default threshold" : `Auto-compact starts at ${at()}% of the context window`);
      } else say(context, `Unknown setting or value: ${args.trim()}. Run /config to list the settings.`);
      return { done: "end_turn" };
    },
  };
  return { compaction, options, set, config };
}

export interface LocalExtensionOptions {
  filesystem: FileSystem;
  root: string;
  configuration: Configuration;
  sessions: SessionStore;
  update(sessionId: string, update: Params): void;
}

/** Instructions from the workspace and the instructions setting, skills from the workspace, find_files, compaction, /goal, /loop, /config and saved sessions. Hooks and MCP need a host process. */
export function localExtensions({ filesystem, root, configuration, sessions, update }: LocalExtensionOptions) {
  const files = workspaceFiles(filesystem, root);
  const instructions = new Instructions({ files, get append() {
    return configuration.get<string>(OXBIT_INSTRUCTIONS_SETTING) || undefined;
  } });
  const skills = new Skills({ files, roots: [] });
  const control = controlExtensions({ update });
  const settings = compactSettings(configuration);
  const extensions: AgentExtensions = {
    context: [instructions, ...control.context, skills],
    tools: [...control.tools, skills, { tools: () => filesystem.findFiles ? [findFiles] : [] }],
    commands: [settings.compaction, ...control.commands, { commands: () => [settings.config] },
      { commands: async (session) => (await skills.discover(session.cwd), skills.commands(session).filter((command) => command.name !== "config")) }],
    continuations: control.continuations,
    compactor: settings.compaction,
    sessions,
  };
  return { extensions, settings };
}
