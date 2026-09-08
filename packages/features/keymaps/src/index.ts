import type { Extension, Kernel } from "@oxbit/sdk";
import { KEYMAP_SETTING, keymapConfiguration } from "./configuration.js";
import { keymaps } from "./maps/index.js";

export { keymaps } from "./maps/index.js";
export type { Keymap } from "./maps/index.js";

export { KEYMAP_SETTING } from "./configuration.js";

export function createFeature({ kernel }: { kernel: Kernel }): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.keymaps",
      name: "Keymaps",
      description:
        "JetBrains, macOS, VS Code, Sublime Text, Atom, Visual Studio, and Emacs keyboard layouts. None is applied until one is selected in Settings.",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      configuration: keymapConfiguration,
      contributions: keymaps.map((keymap) => ({
        id: `oxbit.keymaps/${keymap.stableId}`,
        kind: "keymap" as const,
        title: keymap.title,
        data: { stableId: keymap.stableId, bindings: keymap.bindings },
      })),
    },
    activate(ctx) {
      for (const keymap of [
        { stableId: "default", title: "Oxbit Default" },
        ...keymaps,
      ])
        ctx.own(
          ctx.commands.register({
            id: `keymap.use.${keymap.stableId}`,
            title: `Use ${keymap.title} Keymap`,
            category: "Preferences",
            run: () => kernel.configuration.set(KEYMAP_SETTING, keymap.stableId),
          }),
        );
    },
  };
}
