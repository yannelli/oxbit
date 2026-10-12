import type { PanelId, SettingsManager } from "../tui/connection.js";
import { configPanel } from "./config.js";
import { hooksPanel } from "./hooks.js";
import { instructionsPanel } from "./instructions.js";
import { mcpPanel } from "./mcp.js";
import { providersPanel } from "./providers.js";
import type { PanelHandler, SettingsDeps } from "./shared.js";
import { skillsPanel } from "./skills.js";

export type { SettingsDeps } from "./shared.js";
export { compactConfigOptions } from "./config.js";
export { settingsCommands } from "./commands.js";

const PANELS: Record<PanelId, PanelHandler> = {
  config: configPanel, skills: skillsPanel, hooks: hooksPanel, mcp: mcpPanel, instructions: instructionsPanel, providers: providersPanel,
};
const handler = (id: PanelId) => {
  const panel = Object.hasOwn(PANELS, id) ? PANELS[id] : undefined;
  if (!panel) throw new Error(`Unknown settings panel ${id}`);
  return panel;
};
const unsupported = (id: PanelId, what: string) => new Error(`The ${id} panel has nothing to ${what}`);

/** The /config, /skills, /hooks, /mcp, /instructions and /providers panels over ~/.oxbit/agent settings. */
export function createSettingsManager(deps: SettingsDeps): SettingsManager {
  return {
    panel: (id, context) => handler(id).panel(deps, context),
    async toggle(id, rowId, enabled, context) {
      const panel = handler(id);
      if (!panel.toggle) throw unsupported(id, "turn on or off");
      return panel.toggle(deps, rowId, enabled, context);
    },
    async choose(id, rowId, value, context) {
      const panel = handler(id);
      if (!panel.choose) throw unsupported(id, "choose");
      return panel.choose(deps, rowId, value, context);
    },
    async act(id, rowId, actionId, inputs, context) {
      const panel = handler(id);
      if (!panel.act) throw unsupported(id, "run");
      return panel.act(deps, rowId, actionId, inputs, context);
    },
  };
}
