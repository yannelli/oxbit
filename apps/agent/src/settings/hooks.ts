import { listHooks } from "@oxbit/agent-core";
import { stringList } from "../config.js";
import { hookSources } from "../extensions.js";
import type { PanelRow } from "../tui/connection.js";
import { flagRow, setFlag } from "./config.js";
import { setListed, tilde, unknownRow, userHome, warningRows, type PanelHandler, type SettingsDeps } from "./shared.js";

async function parsedHooks(deps: SettingsDeps, cwd: string) {
  const sources = await hookSources(deps.config, userHome(deps))(cwd);
  const off = sources.find((source) => (source.config as { disableAllHooks?: unknown } | null)?.disableAllHooks === true);
  return { ...listHooks(sources), off: off?.path };
}

export const hooksPanel: PanelHandler = {
  async panel(deps, { cwd }) {
    const home = userHome(deps);
    const { hooks, warnings, off } = await parsedHooks(deps, cwd);
    const disabled = new Set(stringList(deps.config.settings.disabledHooks));
    const rows: PanelRow[] = [flagRow(deps.config, "claude-hooks", "Sources"), flagRow(deps.config, "codex-hooks", "Sources"),
      ...hooks.map((hook) => ({ id: hook.id, section: "Hooks", label: `${hook.event} ${hook.matcher}`.trim(),
        detail: `${hook.command} · ${tilde(hook.path, home)}`, enabled: !disabled.has(hook.id) }))];
    if (!hooks.length) rows.push({ id: "none", section: "Hooks", label: "No command hooks in the loaded files" });
    rows.push(...warningRows(warnings));
    return { id: "hooks", title: "Hooks", rows,
      footer: off ? `disableAllHooks in ${tilde(off, home)} turns every hook off.` : `Hooks come from ${tilde(deps.config.paths.settings, home)} and the project's .oxbit/settings.json.` };
  },
  async toggle(deps, rowId, enabled, { cwd }) {
    if (rowId === "claude-hooks" || rowId === "codex-hooks") return setFlag(deps.config, rowId, enabled);
    const hook = (await parsedHooks(deps, cwd)).hooks.find((item) => item.id === rowId);
    if (!hook && !stringList(deps.config.settings.disabledHooks).includes(rowId)) throw unknownRow(rowId);
    await setListed(deps.config, "disabledHooks", rowId, !enabled);
    return { message: `${hook ? `${hook.event} hook "${hook.command}"` : "The hook"} is ${enabled ? "on" : "off"}` };
  },
};
