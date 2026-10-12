import { stringList } from "../config.js";
import { instructionsFor, type ExtensionSettings } from "../extensions.js";
import type { PanelRow } from "../tui/connection.js";
import { firstLine, setListed, tilde, unknownRow, userHome, type PanelHandler } from "./shared.js";

const SECTIONS = { global: "Global files", claude: "Global files", project: "Project files" };

export const instructionsPanel: PanelHandler = {
  async panel(deps, { cwd }) {
    const home = userHome(deps);
    const append = (deps.config.settings as ExtensionSettings).appendSystemPrompt;
    const prompt = typeof append === "string" ? append : "";
    const disabled = new Set(stringList(deps.config.settings.disabledInstructions));
    const files = await instructionsFor(deps.config, home).candidates(cwd);
    const rows: PanelRow[] = [
      { id: "prompt", section: "Global prompt", label: "Global prompt", detail: firstLine(prompt) || "none",
        actions: [{ id: "edit", label: "Edit", inputs: [{ label: "Text added after the instruction files (empty clears it)", value: prompt }] }] },
      ...files.map((file) => ({ id: file.path, section: SECTIONS[file.scope], label: tilde(file.path, home),
        ...file.text === undefined ? { detail: "not found" } : { detail: firstLine(file.text), enabled: !disabled.has(file.path) } })),
    ];
    return { id: "instructions", title: "Instructions", rows, footer: "Changes apply to the next turn's system prompt." };
  },
  async toggle(deps, rowId, enabled, { cwd }) {
    const files = await instructionsFor(deps.config, userHome(deps)).candidates(cwd);
    const known = files.some((file) => file.path === rowId && file.text !== undefined) || stringList(deps.config.settings.disabledInstructions).includes(rowId);
    if (!known) throw unknownRow(rowId);
    await setListed(deps.config, "disabledInstructions", rowId, !enabled);
    return { message: `${tilde(rowId, userHome(deps))} is ${enabled ? "on" : "off"}` };
  },
  async act({ config }, rowId, actionId, inputs) {
    if (rowId !== "prompt" || actionId !== "edit") throw unknownRow(`${rowId} ${actionId}`);
    const text = inputs[0] ?? "";
    await config.saveSettings({ appendSystemPrompt: text.trim() ? text : undefined });
    return { message: text.trim() ? "Saved the global prompt" : "Cleared the global prompt" };
  },
};
