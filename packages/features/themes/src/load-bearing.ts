// Deprecated module path. Palettes are authored in packs/*.json.
export { loadBearingThemes } from "./bundled.js";
export interface ColorTheme { highContrast?: boolean; mode: "light"|"dark"; pairedTheme: string; variables: Record<string,string> }
