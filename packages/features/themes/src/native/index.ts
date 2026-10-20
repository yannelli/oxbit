import type { Pack } from "@oxbit/icon-themes";
import { fileFamilies, folderFamilies, type Color } from "./families.js";
import { extensionGroups } from "./extensions.js";
import { fileNameGroups } from "./filenames.js";
import { folderNameGroups, languageIdGroups } from "./folders.js";
import { fileIcon, folderIcon, type Icon, type Layer } from "./glyphs.js";

type Theme = Pack["themes"][number]["data"];
type Mode = "dark" | "light" | "highContrast";
type Swatch = [line: string, tint: string, tile: string];
export const NATIVE_PACK_ID = "oxbit.native";

// Line, tint and tile colors per mode.
const colors: Record<Exclude<Mode, "highContrast">, Record<Color, Swatch>> = {
  dark: {
    blue: ["#548AF7", "#25324D", "#548AF7"], red: ["#DB5C5C", "#402929", "#DB5C5C"], orange: ["#E08855", "#45322B", "#E08855"],
    purple: ["#B589EC", "#2F2936", "#B589EC"], green: ["#57965C", "#253627", "#57965C"], yellow: ["#D6AE58", "#3D3223", "#F2C55C"],
    teal: ["#3DB5A7", "#1F3533", "#3DB5A7"], pink: ["#E36EAE", "#3F2836", "#E36EAE"], gray: ["#CED0D6", "#43454A", "#CED0D6"],
  },
  light: {
    blue: ["#3574F0", "#EDF3FF", "#3574F0"], red: ["#DB3B4B", "#FFF7F7", "#DB3B4B"], orange: ["#E66D17", "#FFF4EB", "#E66D17"],
    purple: ["#834DF0", "#FAF5FF", "#834DF0"], green: ["#369650", "#F2FCF3", "#369650"], yellow: ["#C27D04", "#FFFAEB", "#FFAF0F"],
    teal: ["#0F8A7E", "#EDFAF8", "#0F8A7E"], pink: ["#D43D8E", "#FFF0F7", "#D43D8E"], gray: ["#6C707E", "#EBECF0", "#6C707E"],
  },
};
// High contrast themes can be black or white: light line colors keep 3:1 on both, so tiles drop their tint.
const highContrast = Object.fromEntries(Object.entries(colors.light).map(([color, [line]]) => [color, [line, "none", line]])) as Record<Color, Swatch>;
const swatches: Record<Mode, Record<Color, Swatch>> = { ...colors, highContrast };
const knockout: Record<Mode, string> = { dark: "#1E1F22", light: "#000000", highContrast: "#000000" };

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function palette(mode: Mode): Record<string, string> {
  const paint: Record<string, string> = { white: "#FFFFFF", knock: knockout[mode] };
  for (const [color, [line, tint, tile]] of Object.entries(swatches[mode])) {
    Object.assign(paint, { [color]: line, [`${color}-tint`]: tint, [`${color}-tile`]: tile });
    // Letters are white except on light tiles such as yellow.
    paint[`ink-${color}`] = contrast(tile, "#FFFFFF") >= 2 ? "#FFFFFF" : knockout[mode];
    paint[`accent-${color}`] = mode === "highContrast" ? "#FFFFFF" : tile;
  }
  return paint;
}

function render(icon: Icon, paint: Record<string, string>) {
  const color = (token: string) => {
    if (!paint[token]) throw new Error(`Unknown icon paint: ${token}`);
    return paint[token];
  };
  const path = (l: Layer) =>
    `<path d="${l.d}" fill="${l.f ? color(l.f) : "none"}"` +
    (l.s ? ` stroke="${color(l.s)}" stroke-width="${l.w ?? 1}" stroke-linecap="${l.cap ?? "round"}" stroke-linejoin="round"` : "") +
    (l.transform ? ` transform="${l.transform}"` : "") + "/>";
  const base = icon.layers.map(path).join("");
  const body = icon.cut
    ? `<mask id="cut"><rect width="16" height="16" fill="#fff"/><path d="${icon.cut}" fill="#000" stroke="#000" stroke-width="3" stroke-linejoin="round"/></mask>` +
      `<g mask="url(#cut)">${base}</g>${(icon.badge ?? []).map(path).join("")}`
    : base;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">${body}</svg>`;
}

const invert = (groups: Record<string, string>) =>
  Object.fromEntries(Object.entries(groups).flatMap(([id, keys]) => keys.split(/\s+/).filter(Boolean).map((key) => [key.toLowerCase(), id])));

/** Lowercase key to family ID, before the per-mode definition prefix. */
export const nativeAssociations = {
  fileExtensions: invert(extensionGroups),
  fileNames: invert(fileNameGroups),
  folderNames: invert(folderNameGroups),
  languageIds: invert(languageIdGroups),
};

const assets: Pack["assets"] = Object.create(null);
const definitions: Theme["iconDefinitions"] = {};
function define(id: string, icon: Icon, paint: Record<string, string>) {
  const path = `icons/${id.replaceAll(".", "/")}.svg`;
  assets[path] = { mime: "image/svg+xml", base64: btoa(render(icon, paint)) };
  definitions[id] = { iconPath: path };
}
for (const mode of ["dark", "light", "highContrast"] as const) {
  const paint = palette(mode);
  for (const [id, family] of Object.entries(fileFamilies)) define(`${mode}.${id}`, fileIcon(family, fileFamilies), paint);
  for (const [id, family] of Object.entries(folderFamilies)) define(`${mode}.folder.${id}`, folderIcon(family), paint);
}

function associations(mode: Mode) {
  const prefix = (entries: Record<string, string>, kind = "") =>
    Object.fromEntries(Object.entries(entries).map(([key, id]) => [key, `${mode}.${kind}${id}`]));
  return {
    file: `${mode}.file`,
    folder: `${mode}.folder.folder`,
    rootFolder: `${mode}.folder.root`,
    fileExtensions: prefix(nativeAssociations.fileExtensions),
    fileNames: prefix(nativeAssociations.fileNames),
    languageIds: prefix(nativeAssociations.languageIds),
    folderNames: prefix(nativeAssociations.folderNames, "folder."),
  };
}

/** Built-in file icons behind `oxbit.default`; the icon service loads it directly, outside the pack store. */
export const nativeIconPack: Pack = {
  formatVersion: 1,
  id: NATIVE_PACK_ID,
  revision: "3f0c6a52-8d1e-4f7b-9a64-2c5b7e9d1a40",
  label: "Oxbit",
  publisher: "oxbit",
  version: "1.0.0",
  license: "MIT",
  enabled: true,
  description: "Oxbit file and folder icons that follow light and dark themes.",
  themes: [
    {
      id: `${NATIVE_PACK_ID}/files`,
      kind: "fileIconTheme",
      label: "Oxbit",
      path: "files.json",
      data: { iconDefinitions: definitions, ...associations("dark"), light: associations("light"), highContrast: associations("highContrast") },
    },
  ],
  assets,
  warnings: [],
};
