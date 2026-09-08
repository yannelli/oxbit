import type { Extension, Kernel } from "@oxbit/sdk";
import { coreThemes, loadBearingThemes, binxThemes } from "./bundled.js";
import { attachPackManager } from "./manager.js";
import type { WorkbenchController } from "@oxbit/workbench";
interface ColorTheme {
  mode: "light" | "dark";
  pairedTheme: string;
  stableId: string;
}

export { loadBearingThemes } from "./bundled.js";
export { binxThemes } from "./bundled.js";
export { vscodeThemes, vscodeHighContrastThemes } from "./bundled.js";
export {
  createVSCodeFeature,
  createVSCodeHighContrastFeature,
} from "./vscode-packs.js";
export { createClassicOS98Feature } from "./classicos98-pack.js";
export { classicOS98Themes } from "./bundled.js";
export {
  classicOS98IconPack,
  CLASSICOS98_PACK_ID,
  CLASSICOS98_REVISION,
} from "./classicos98/index.js";

export function createFeature({
  kernel,
  workbench,
}: {
  kernel: Kernel;
  workbench?: WorkbenchController;
}): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.themes",
      name: "Oxbit Themes",
      description:
        "Graphite, Paper, Load Bearing, and Binx — light and dark themes from warm paper to deep black and arctic blue.",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      contributions: [...coreThemes, ...loadBearingThemes, ...binxThemes],
    },
    activate(ctx) {
      if (workbench) attachPackManager(ctx, kernel, workbench);
      ctx.own(
        ctx.commands.register({
          id: "theme.toggle",
          title: "Toggle Light/Dark Theme",
          category: "Preferences",
          shortcut: "Ctrl+K Ctrl+T",
          run: () => {
            const themes = kernel.contributions.list("theme");
            const selected = themes.find((theme) =>
              [theme.title, (theme.data as ColorTheme).stableId].includes(
                kernel.configuration.get<string>("workbench.colorTheme"),
              ),
            );
            const data = selected?.data as Partial<ColorTheme> | undefined;
            const paired = themes.find(
              (theme) => theme.id === data?.pairedTheme,
            );
            kernel.configuration.set(
              "workbench.colorTheme",
              (paired?.data as ColorTheme)?.stableId ??
                (data?.mode === "light"
                  ? "oxbit.core/graphite"
                  : "oxbit.core/paper"),
            );
          },
        }),
      );
      for (const theme of loadBearingThemes)
        ctx.own(
          ctx.commands.register({
            id: `theme.loadBearing.${theme.data.mode}`,
            title: `Use ${theme.title}`,
            category: "Preferences",
            run: () =>
              kernel.configuration.set(
                "workbench.colorTheme",
                theme.data.stableId,
              ),
          }),
        );
      for (const theme of binxThemes)
        ctx.own(
          ctx.commands.register({
            id: `theme.${theme.id.replace("oxbit.", "")}`,
            title: `Use ${theme.title}`,
            category: "Preferences",
            run: () =>
              kernel.configuration.set(
                "workbench.colorTheme",
                theme.data.stableId,
              ),
          }),
        );
    },
  };
}

export { bundledPacks, packContributions } from "./bundled.js";
export { ManageThemePacks } from "./manager.js";
