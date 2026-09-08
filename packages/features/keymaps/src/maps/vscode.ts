import type { Keymap } from "./types.js";
export const vscode: Keymap = {
  stableId: "vscode",
  title: "VS Code",
  description:
    "Visual Studio Code defaults. Oxbit already ships most of them; this keymap aligns the few that differ, including Ctrl+R for Go to Recent.",
  bindings: {
    "workbench.recent": "Ctrl+R",
    "workspace.switch": "",
    "file.copyPath": "Shift+Alt+C",
  },
};
