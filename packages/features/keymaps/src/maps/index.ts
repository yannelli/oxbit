import { atom } from "./atom.js";
import { emacs } from "./emacs.js";
import { jetbrains } from "./jetbrains.js";
import { macos } from "./macos.js";
import { sublime } from "./sublime.js";
import { visualStudio } from "./visual-studio.js";
import { vscode } from "./vscode.js";
export type { Keymap } from "./types.js";
export const keymaps = [
  vscode,
  jetbrains,
  macos,
  sublime,
  atom,
  visualStudio,
  emacs,
] as const;
