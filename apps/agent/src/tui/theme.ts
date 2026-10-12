import { createContext, useContext } from "react";

export interface Theme {
  name: "dark" | "light";
  accent: string;
  muted: string;
  user: string;
  success: string;
  error: string;
  warning: string;
  link: string;
  code: string;
  keyword: string;
  string: string;
  number: string;
  added: string;
  removed: string;
  addedBg: string;
  removedBg: string;
  border: string;
  modes: Record<string, string>;
}

export const THEMES: Record<Theme["name"], Theme> = {
  dark: {
    name: "dark", accent: "#8ab4f8", muted: "gray", user: "#c8d3f5", success: "#9ece6a", error: "#f7768e", warning: "#e0af68",
    link: "#7dcfff", code: "#e0af68", keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", added: "#9ece6a",
    removed: "#f7768e", addedBg: "#1d3325", removedBg: "#3b1f27", border: "gray",
    modes: { ask: "gray", "accept-edits": "#bb9af7", "full-auto": "#e0af68" },
  },
  light: {
    name: "light", accent: "#1d4ed8", muted: "gray", user: "#1e293b", success: "#15803d", error: "#b91c1c", warning: "#b45309",
    link: "#0369a1", code: "#9a3412", keyword: "#7c3aed", string: "#15803d", number: "#c2410c", added: "#166534",
    removed: "#991b1b", addedBg: "#dcfce7", removedBg: "#fee2e2", border: "gray",
    modes: { ask: "gray", "accept-edits": "#7c3aed", "full-auto": "#b45309" },
  },
};

/** `auto` reads COLORFGBG ("fg;bg"), which xterm, rxvt, Konsole and iTerm2 set; dark when it is absent. */
export function resolveTheme(choice: "dark" | "light" | "auto" = "auto", env: Record<string, string | undefined> = process.env): Theme {
  if (choice !== "auto") return THEMES[choice];
  const background = Number(env.COLORFGBG?.split(";").at(-1));
  return THEMES[Number.isInteger(background) && (background === 7 || background >= 9) ? "light" : "dark"];
}

export const ThemeContext = createContext<Theme>(THEMES.dark);
export const useTheme = () => useContext(ThemeContext);
