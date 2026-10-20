import type { Color, FileFamily, FolderFamily } from "./families.js";

/** Paint tokens resolve per mode: a color is its line, `-tint` its fill, `-tile` its solid tile, `ink-` its knockout, `accent-` colored letters. */
export interface Layer { d: string; f?: string; s?: string; w?: number; cap?: "butt" | "round"; transform?: string }
export interface Icon { layers: Layer[]; cut?: string; badge?: Layer[] }

const TILE = "M4 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z";
const TINT = "M4 2.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5z";
const WIDE = "M3 2.5h10A1.5 1.5 0 0 1 14.5 4v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5z";
const FOLDER = "M2.75 2.5h3.4a.5 .5 0 0 1 .36.15L8.25 4.5H13A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.75A1.25 1.25 0 0 1 2.75 2.5z";
const RUN_LEFT = "M11.25 10.5v5l-3-2.5z", RUN_RIGHT = "M12.75 10.5v5l3-2.5z";

// Centerlines in a box 6 units tall; w is the advance including a 1-unit stroke.
const alphabet: Record<string, { w: number; d: string }> = {
  A: { w: 4.5, d: "M0.5 5.5 2.25 0.5 4 5.5 M1.1 3.8h2.3" },
  B: { w: 4.25, d: "M0.5 0.5V5.5H2.5a1.25 1.25 0 0 0 0-2.5H0.5 M0.5 0.5h1.75a1.25 1.25 0 0 1 0 2.5" },
  C: { w: 4.25, d: "M3.6 1.35A1.75 2.5 0 1 0 3.6 4.65" },
  D: { w: 4.25, d: "M0.5 0.5V5.5H1.75A2 2.5 0 0 0 1.75 0.5z" },
  E: { w: 3.75, d: "M3.25 0.5H0.5V5.5H3.25 M0.5 3h2.4" },
  F: { w: 3.5, d: "M3.25 0.5H0.5V5.5 M0.5 3h2.4" },
  G: { w: 4.75, d: "M3.85 1.4A1.9 2.5 0 1 0 4.25 3H2.6" },
  H: { w: 4, d: "M0.5 0.5v5 M3.5 0.5v5 M0.5 3h3" },
  I: { w: 2.5, d: "M0.5 0.5h1.5 M1.25 0.5v5 M0.5 5.5h1.5" },
  J: { w: 3.5, d: "M3 0.5V4.3A1.2 1.2 0 0 1 0.6 4.3" },
  K: { w: 4, d: "M0.5 0.5v5 M3.5 0.5 0.5 3.4 M1.6 2.4l1.9 3.1" },
  L: { w: 3.5, d: "M0.5 0.5V5.5H3.25" },
  M: { w: 5, d: "M0.5 5.5V0.5l2 3 2-3v5" },
  N: { w: 4, d: "M0.5 5.5v-5l3 5v-5" },
  O: { w: 4.5, d: "M2.25 0.5a1.75 2.5 0 1 0 0 5a1.75 2.5 0 1 0 0-5z" },
  P: { w: 4, d: "M0.5 5.5V0.5h1.75a1.4 1.4 0 0 1 0 2.8H0.5" },
  Q: { w: 4.5, d: "M2.25 0.5a1.75 2.5 0 1 0 0 5a1.75 2.5 0 1 0 0-5z M2.6 4l1.5 1.75" },
  R: { w: 4, d: "M0.5 5.5V0.5h1.75a1.4 1.4 0 0 1 0 2.8H0.5 M2.1 3.3l1.6 2.2" },
  S: { w: 4, d: "M3.25 1.4C3.15 0.8 2.65 0.5 2 0.5S0.75 0.9 0.75 1.6C0.75 2.4 1.45 2.7 2 2.85S3.35 3.4 3.35 4.3C3.35 5.1 2.65 5.5 1.95 5.5S0.55 5.1 0.5 4.4" },
  T: { w: 4, d: "M0.25 0.5h3.5 M2 0.5v5" },
  U: { w: 4, d: "M0.5 0.5V3.75a1.5 1.75 0 0 0 3 0V0.5" },
  V: { w: 4.5, d: "M0.5 0.5l1.75 5 1.75-5" },
  W: { w: 6, d: "M0.5 0.5l1.1 5 1.4-4 1.4 4 1.1-5" },
  X: { w: 4, d: "M0.5 0.5l3 5 M3.5 0.5l-3 5" },
  Y: { w: 4, d: "M0.5 0.5 2 3l1.5-2.5 M2 3v2.5" },
  Z: { w: 4, d: "M0.5 0.5h3l-3 5h3" },
  a: { w: 3.5, d: "M1.75 2.75a1.25 1.375 0 1 0 0 2.75a1.25 1.375 0 1 0 0-2.75z M3 2.75v2.75" },
  0: { w: 4, d: "M2 0.5a1.5 2.5 0 1 0 0 5a1.5 2.5 0 1 0 0-5z" },
  1: { w: 2.75, d: "M0.6 1.4 1.9 0.5V5.5" },
  "+": { w: 3.5, d: "M1.75 1.5v3 M0.25 3h3" },
  "#": { w: 4.5, d: "M1.6 0.5 1 5.5 M3.5 0.5l-.6 5 M0.5 2h3.6 M0.3 4h3.6" },
  "λ": { w: 4, d: "M0.6 0.5c.9 0 1.2.4 1.5 1.3L3.6 5.5 M2.1 2.6.5 5.5" },
  "{": { w: 3.1, d: "M2.6 0.5h-.4a.85 .85 0 0 0-.85.85v.8A.85 .85 0 0 1 .5 3a.85 .85 0 0 1 .85.85v.8a.85 .85 0 0 0 .85.85h.4" },
  "}": { w: 3.1, d: "M0.5 0.5h.4a.85 .85 0 0 1 .85.85v.8A.85 .85 0 0 0 2.6 3a.85 .85 0 0 0-.85.85v.8a.85 .85 0 0 1-.85.85h-.4" },
};
const GAP = 0.6;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Fits a label to a tile: one character is largest, three are condensed to the available width. */
function lettering(label: string, ink: string, solid: boolean): Layer[] {
  const chars = [...label];
  const width = chars.reduce((sum, c) => sum + alphabet[c].w, 0) + GAP * (chars.length - 1);
  const cap = (solid ? [7, 6, 5] : [6.5, 5.5, 4.5])[Math.min(chars.length, 3) - 1];
  const scale = Math.min(cap / 6, (solid ? 10.5 : 8.5) / width);
  const weight = chars.length === 1 ? 1.15 : 1;
  const top = solid && chars.length > 1 ? 12.25 - 6 * scale : 8 - 3 * scale;
  let x = 8 - (width * scale) / 2;
  return chars.map((c) => {
    const layer: Layer = { d: alphabet[c].d, s: ink, w: round(weight / scale), cap: "butt", transform: `translate(${round(x)} ${round(top)}) scale(${round(scale)})` };
    x += (alphabet[c].w + GAP) * scale;
    return layer;
  });
}

function gear(cx: number, cy: number, outer: number, inner: number, teeth: number, hole: number) {
  const step = (2 * Math.PI) / teeth, at = (r: number, a: number) => `${round(cx + r * Math.cos(a))} ${round(cy + r * Math.sin(a))}`;
  const points = Array.from({ length: teeth }, (_, i) => {
    const a = i * step - Math.PI / 2;
    return [at(inner, a - step * 0.3), at(outer, a - step * 0.14), at(outer, a + step * 0.14), at(inner, a + step * 0.3)].join("L");
  });
  return { rim: `M${points.join("L")}z`, hole: `M${cx - hole} ${cy}a${hole} ${hole} 0 1 0 ${hole * 2} 0a${hole} ${hole} 0 1 0-${hole * 2} 0z` };
}
const bigGear = gear(8, 8, 6.5, 4.9, 8, 2), miniGear = gear(12.5, 12.5, 3.25, 2.3, 6, 0.9);
const BRACES = "M6.5 2.5H6A1.5 1.5 0 0 0 4.5 4v2.25A1.75 1.75 0 0 1 2.75 8a1.75 1.75 0 0 1 1.75 1.75V12A1.5 1.5 0 0 0 6 13.5h.5 M9.5 2.5h.5A1.5 1.5 0 0 1 11.5 4v2.25A1.75 1.75 0 0 0 13.25 8a1.75 1.75 0 0 0-1.75 1.75V12a1.5 1.5 0 0 1-1.5 1.5h-.5";
const tinted = (c: Color, glyph: string, w = 1): Layer[] => [{ d: TINT, f: `${c}-tint`, s: c }, { d: glyph, s: c, w }];

const glyphs: Record<string, (c: Color) => Layer[]> = {
  text: (c) => [{ d: "M2.5 3.5h11 M2.5 6.5h7 M2.5 9.5h11 M2.5 12.5h7", s: c }],
  atom: (c) => [
    { d: "M1.5 8a6.5 2.4 0 1 0 13 0a6.5 2.4 0 1 0-13 0z M4.75 2.371a6.5 2.4 60 1 0 6.5 11.258a6.5 2.4 60 1 0-6.5-11.258z M11.25 2.371a6.5 2.4 120 1 0-6.5 11.258a6.5 2.4 120 1 0 6.5-11.258z", s: c },
    { d: "M7 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0z", f: c },
  ],
  braces: (c) => [{ d: BRACES, s: c, w: 1.1 }],
  bracesComment: (c) => [{ d: `${BRACES} M6.75 10.5l1.25-5 M8.5 10.5l1.25-5`, s: c, w: 1.1 }],
  html: (c) => [{ d: "M6 4.5 1.5 8 6 11.5 M10 4.5l4.5 3.5-4.5 3.5", s: c, w: 1.2 }],
  xml: (c) => [{ d: "M5 4.5 1 8l4 3.5 M11 4.5l4 3.5-4 3.5 M9.5 2.5l-3 11", s: c, w: 1.2 }],
  markdown: (c) => [{ d: "M1.5 12V4.5l3 4.5 3-4.5V12 M12.5 4v7.5 M10 9l2.5 2.5L15 9", s: c, w: 1.2 }],
  gear: (c) => [{ d: bigGear.rim, f: `${c}-tint`, s: c }, { d: bigGear.hole, s: c }],
  env: (c) => tinted(c, "M4.5 8a1.75 1.75 0 1 0 3.5 0a1.75 1.75 0 1 0-3.5 0z M8 8h3.5v1.75"),
  spreadsheet: (c) => tinted(c, "M2.5 6.5h11 M2.5 10h11 M6.5 2.5v11"),
  document: (c) => tinted(c, "M5 5.5h6 M5 8h6 M5 10.5h4"),
  presentation: (c) => tinted(c, "M5 11V8.5 M8 11V5.5 M11 11V7", 1.2),
  image: (c) => tinted(c, "M2.5 10.5l3-3 6 6 M9.25 5.5a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0z"),
  video: (c) => [{ d: TINT, f: `${c}-tint`, s: c }, { d: "M6.5 5.5v5l4-2.5z", f: c, s: c }],
  archive: (c) => [{ d: TINT, f: `${c}-tint`, s: c }, { d: "M8 2.5v1 M8 4.5v1 M8 6.5v1", s: c }, { d: "M6.75 8.5h2.5v3h-2.5z", f: c, s: c }],
  audio: (c) => [
    { d: "M6 11.5V3.5l6.5-1.5v8", s: c, w: 1.2 },
    { d: "M2.75 11.5a1.6 1.3 0 1 0 3.2 0a1.6 1.3 0 1 0-3.2 0z M9.25 10a1.6 1.3 0 1 0 3.2 0a1.6 1.3 0 1 0-3.2 0z", f: c, s: c },
  ],
  database: (c) => [
    { d: "M3 4c0-1.1 2.24-2 5-2s5 .9 5 2v8c0 1.1-2.24 2-5 2s-5-.9-5-2z", f: `${c}-tint`, s: c },
    { d: "M3 4c0 1.1 2.24 2 5 2s5-.9 5-2 M3 8c0 1.1 2.24 2 5 2s5-.9 5-2", s: c },
  ],
  certificate: (c) => [{ d: "M2 8a2.75 2.75 0 1 0 5.5 0a2.75 2.75 0 1 0-5.5 0z M7.5 8h6.5 M12 8v2.5 M14 8v2", s: c, w: 1.2 }],
  license: (c) => [
    { d: "M5.75 9.5 5 14l3-1.5 3 1.5-.75-4.5", f: `${c}-tint`, s: c },
    { d: "M4.25 6.25a3.75 3.75 0 1 0 7.5 0a3.75 3.75 0 1 0-7.5 0z", f: `${c}-tint`, s: c },
  ],
  diff: (c) => [{ d: "M5 2.5v5 M2.5 5h5", s: c, w: 1.2 }, { d: "M8.5 11.5h5", s: "red", w: 1.2 }],
  lock: (c) => [
    { d: "M4.5 6.5h7a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z", f: `${c}-tint`, s: c },
    { d: "M5.5 6.5V5a2.5 2.5 0 0 1 5 0v1.5 M8 9.25v1.5", s: c },
  ],
  shell: (c) => [{ d: WIDE, f: `${c}-tint`, s: c }, { d: "M4 6l2 2-2 2 M7.5 10.5h4", s: c, w: 1.2 }],
  git: (c) => [
    { d: "M8.7 1.7l5.6 5.6a1 1 0 0 1 0 1.4l-5.6 5.6a1 1 0 0 1-1.4 0L1.7 8.7a1 1 0 0 1 0-1.4l5.6-5.6a1 1 0 0 1 1.4 0z", f: c },
    { d: "M6.5 5.5v5 M6.5 6.5l3.25 3.25", s: "white" },
    { d: "M6.5 5.5h.01 M6.5 10.5h.01 M9.75 9.75h.01", s: "white", w: 2 },
  ],
  ignore: (c) => [{ d: "M1.5 8a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0z", f: `${c}-tint`, s: c }, { d: "M3.5 12.5l9-9", s: c }],
  docker: (c) => [
    { d: "M3.5 6h2v2h-2z M6.25 6h2v2h-2z M9 6h2v2H9z M6.25 3.25h2v2h-2z", f: c },
    { d: "M1.5 9h12.25a.5 .5 0 0 1 .49.6C13.6 12 11.3 13.5 8.25 13.5H6.5C3.6 13.5 1.9 11.8 1.5 9.5z", f: c },
  ],
  npm: (c) => [{ d: "M8 1.5l6 3v7l-6 3-6-3v-7z", f: `${c}-tint`, s: c }, { d: "M2 4.5l6 3 6-3 M8 7.5v7", s: c }],
  agent: (c) => [
    { d: "M7 2l1.4 3.6L12 7l-3.6 1.4L7 12l-1.4-3.6L2 7l3.6-1.4z", f: `${c}-tint`, s: c },
    { d: "M12.5 10.5v4 M10.5 12.5h4", s: c },
  ],
};

/** Folder badges sit in the bottom-right corner; `cut` is the outline carved from the folder. */
const badges: Record<string, { cut: string; layers: Layer[] }> = {
  module: { cut: "M11 9.5h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9.5 14v-3A1.5 1.5 0 0 1 11 9.5z", layers: [] },
  cube: { cut: "M12.5 9.25l3 1.5v3.5l-3 1.5-3-1.5v-3.5z", layers: [{ d: "M9.5 10.75l3 1.5 3-1.5 M12.5 12.25v3.5", s: "orange" }] },
  gear: { cut: miniGear.rim, layers: [{ d: miniGear.hole, s: "blue" }] },
  prompt: { cut: "M10.5 10h4a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1z", layers: [{ d: "M11 11.75l1 1-1 1", s: "green" }] },
  diamond: { cut: "M12.5 9.5l3 3-3 3-3-3z", layers: [] },
  cylinder: { cut: "M9.75 10.5c0-.7 1.25-1.25 2.75-1.25s2.75.55 2.75 1.25v4c0 .7-1.25 1.25-2.75 1.25s-2.75-.55-2.75-1.25z", layers: [{ d: "M9.75 10.5c0 .7 1.25 1.25 2.75 1.25s2.75-.55 2.75-1.25", s: "blue" }] },
  sparkle: { cut: "M12.5 9l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z", layers: [] },
};
const badgeFill: Record<string, [string, string]> = {
  module: ["blue-tint", "blue"], cube: ["orange-tint", "orange"], gear: ["blue-tint", "blue"], prompt: ["green-tint", "green"],
  diamond: ["orange", "orange"], cylinder: ["blue-tint", "blue"], sparkle: ["purple", "purple"],
};

export function fileIcon(family: FileFamily, families: Record<string, FileFamily>): Icon {
  switch (family.kind) {
    case "solid": return { layers: [{ d: TILE, f: `${family.color}-tile` }, ...lettering(family.label, family.ink ? `accent-${family.ink}` : `ink-${family.color}`, true)] };
    case "tint": return { layers: [{ d: TINT, f: `${family.color}-tint`, s: family.color }, ...lettering(family.label, family.color, false)] };
    case "glyph": return { layers: glyphs[family.glyph](family.color) };
    case "test": {
      const base = fileIcon(families[family.base], families);
      return { ...base, cut: `${RUN_LEFT} ${RUN_RIGHT}`, badge: [{ d: RUN_LEFT, f: "red", s: "red" }, { d: RUN_RIGHT, f: "green", s: "green" }] };
    }
  }
}

export function folderIcon(family: FolderFamily): Icon {
  const layers: Layer[] = [{ d: FOLDER, f: `${family.color}-tint`, s: family.color }];
  if (!family.badge) return { layers };
  const badge = badges[family.badge], [fill, line] = badgeFill[family.badge];
  return { layers, cut: badge.cut, badge: [{ d: badge.cut, f: fill, s: line }, ...badge.layers] };
}

export const hasGlyph = (name: string) => Object.hasOwn(glyphs, name);
export const hasLetters = (label: string) => [...label].every((c) => Object.hasOwn(alphabet, c));
