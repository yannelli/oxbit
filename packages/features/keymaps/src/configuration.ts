import type { Setting } from "@oxbit/sdk";
import { keymaps } from "./maps/index.js";

export const KEYMAP_SETTING = "workbench.keymap";
export const keymapConfiguration: Setting[] = [
  {
    id: KEYMAP_SETTING,
    title: "Keymap",
    description:
      "Keyboard layout applied on top of the Oxbit defaults. User keybindings always win.",
    type: "string",
    category: "Appearance",
    default: "default",
    enum: ["default", ...keymaps.map((keymap) => keymap.stableId)],
  },
];
