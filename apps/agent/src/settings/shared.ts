import { homedir } from "node:os";
import type { Fetch } from "@oxbit/agent-core";
import type { FileAuthStore } from "../auth.js";
import { stringList, type AgentConfig, type AgentSettings } from "../config.js";
import type { ActiveProvider } from "../providers.js";
import type { Panel, PanelChange, PanelContext, PanelRow } from "../tui/connection.js";

export interface SettingsDeps {
  config: AgentConfig;
  auth: FileAuthStore;
  env: Record<string, string | undefined>;
  fetch?: Fetch;
  /** The user's home for ~/.claude, ~/.codex and ~/.agents. Defaults to os.homedir(). */
  home?: string;
  /** The provider of the running agent. */
  provider(): ActiveProvider;
  /** Rebuilds the agent with `provider`. Without it, provider changes apply after a restart. */
  rebuild?(provider: string): Promise<void>;
  /** Opens the system browser for Sign in with ChatGPT; resolves false when none opened. */
  open?(url: string): Promise<boolean>;
}

export interface PanelHandler {
  panel(deps: SettingsDeps, context: PanelContext): Promise<Panel>;
  toggle?(deps: SettingsDeps, rowId: string, enabled: boolean, context: PanelContext): Promise<PanelChange>;
  choose?(deps: SettingsDeps, rowId: string, value: string, context: PanelContext): Promise<PanelChange>;
  act?(deps: SettingsDeps, rowId: string, actionId: string, inputs: string[], context: PanelContext): Promise<PanelChange>;
}

export type ListKey = "disabledSkills" | "disabledHooks" | "disabledMcpServers" | "disabledInstructions" | "disabledProviders" | "trustedProjects";

export const userHome = (deps: SettingsDeps) => deps.home ?? homedir();

/** Adds `value` to a settings list, or removes it; an empty list drops the key. */
export async function setListed(config: AgentConfig, key: ListKey, value: string, listed: boolean) {
  const list = stringList(config.settings[key]).filter((item) => item !== value);
  if (listed) list.push(value);
  await config.saveSettings({ [key]: list.length ? list : undefined } as Partial<AgentSettings>);
}

export const unknownRow = (rowId: string) => new Error(`Unknown setting ${rowId}`);

/** `path` with the home directory written as ~. */
export const tilde = (path: string, home: string) => path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

export const firstLine = (text: string, max = 80) => {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const warningRows = (warnings: string[]): PanelRow[] =>
  warnings.map((warning, index) => ({ id: `warning:${index}`, section: "Warnings", label: warning }));
