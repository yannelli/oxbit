import { cssVariables, resolveTheme, type ThemePack } from "@oxbit/themes";
import core from "./packs/oxbit.core.json";
import loadBearing from "./packs/oxbit.load-bearing.json";
import binx from "./packs/oxbit.binx.json";
import vscode from "./packs/oxbit.vscode.json";
import highContrast from "./packs/oxbit.vscode-hc.json";
import classicOS98 from "./packs/oxbit.classicos98.json";
import creative from "./packs/oxbit.creative.json";
export const bundledPacks = [
  core,
  loadBearing,
  binx,
  vscode,
  highContrast,
  classicOS98,
  creative,
] as ThemePack[];
export function packContributions(pack: ThemePack) {
  return pack.themes.map((theme) => {
    const resolved = resolveTheme(pack, theme.id);
    return {
      id: `oxbit.${theme.id}`,
      kind: "theme" as const,
      title: theme.name,
      data: {
        mode: theme.mode,
        packName: pack.name,
        pairedTheme: theme.pairedTheme
          ? `oxbit.${theme.pairedTheme}`
          : theme.mode === "dark"
            ? "oxbit.paper"
            : "oxbit.graphite",
        stableId: resolved.id,
        resolved,
        variables: cssVariables(resolved),
      },
    };
  });
}
export const coreThemes = packContributions(bundledPacks[0]);
export const loadBearingThemes = packContributions(bundledPacks[1]);
export const binxThemes = packContributions(bundledPacks[2]);
export const vscodeThemes = packContributions(bundledPacks[3]);
export const vscodeHighContrastThemes = packContributions(bundledPacks[4]);
export const classicOS98Themes = packContributions(bundledPacks[5]);
export const creativeThemes = packContributions(creative as ThemePack);
