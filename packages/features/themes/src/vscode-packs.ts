import type { Extension, Kernel } from "@oxbit/sdk";
import { vscodeHighContrastThemes, vscodeThemes } from "./bundled.js";

function createPack(
  kernel: Kernel,
  id: string,
  name: string,
  description: string,
  themes: typeof vscodeThemes,
): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id,
      name,
      description,
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      contributions: themes,
    },
    activate(ctx) {
      for (const theme of themes)
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

export function createVSCodeFeature({ kernel }: { kernel: Kernel }): Extension {
  return createPack(
    kernel,
    "oxbit.themes-vscode",
    "VS Code Themes",
    "VS Code Modern, Plus, and 2026 palettes, each with light and dark variants.",
    vscodeThemes,
  );
}

export function createVSCodeHighContrastFeature({
  kernel,
}: {
  kernel: Kernel;
}): Extension {
  return createPack(
    kernel,
    "oxbit.themes-vscode-high-contrast",
    "VS Code High Contrast Themes",
    "VS Code High Contrast Dark and Light palettes with prominent borders and focus indicators.",
    vscodeHighContrastThemes,
  );
}
