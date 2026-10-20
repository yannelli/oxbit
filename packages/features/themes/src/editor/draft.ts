import {
  builtinBase,
  catalog,
  resolveTheme,
  validatePack,
  type ColorsToken,
  type ResolvedTheme,
  type Shadow,
  type SyntaxStyle,
  type SyntaxToken,
  type Theme,
  type ThemePack,
  type Typography,
  type TypographyToken,
} from "@oxbit/themes";

/** A theme pack being edited. `installed` means Save updates the pack with the same ID. */
export interface Draft {
  pack: ThemePack;
  themeId: string;
  installed: boolean;
  /** Font files declared in `pack.fonts`, carried from the source pack. */
  assets?: Record<string, Uint8Array>;
}

const COLOR = /^(#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|transparent)$/i;
export const isColor = (value: string) => COLOR.test(value);

export function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "")
      .slice(0, 60) || "theme"
  );
}

export function uniqueId(base: string, taken: Iterable<string>) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Expands a color to `#rrggbbaa`. */
export function expandColor(value: string) {
  if (value === "transparent") return "#00000000";
  const hex = value.slice(1);
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
  return `#${full.length === 6 ? full + "ff" : full}`.toLowerCase();
}

/** Applies a `#rrggbb` picker value and keeps the alpha of the current color. */
export function pickColor(current: string, picked: string) {
  const alpha = isColor(current) ? expandColor(current).slice(7) : "ff";
  return alpha === "ff" ? picked.toLowerCase() : picked.toLowerCase() + alpha;
}

export const pickerValue = (value: string) =>
  isColor(value) ? expandColor(value).slice(0, 7) : "#000000";

export type ColorEntry = { key: ColorsToken; description: string; derived?: string };
export function colorGroups() {
  const groups = new Map<string, ColorEntry[]>();
  for (const [key, value] of Object.entries(catalog.colors)) {
    const group = key.split(".")[0];
    const derived = "source" in value ? (value.source as string) : undefined;
    groups.set(group, [
      ...(groups.get(group) ?? []),
      { key: key as ColorsToken, description: value.description, derived },
    ]);
  }
  return [...groups];
}

export const syntaxRoles = Object.keys(catalog.syntax) as SyntaxToken[];
export const typographyRoles = Object.keys(catalog.typography) as TypographyToken[];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The overrides that turn the built-in base of the same mode into `resolved`. */
export function sparseTheme(resolved: ResolvedTheme, id: string, name: string): Theme {
  const base = builtinBase(resolved.mode);
  const colors: Partial<Record<ColorsToken, string>> = {};
  for (const [key, value] of Object.entries(catalog.colors) as [ColorsToken, { source?: string }][]) {
    const derived = value.source
      ? value.source.startsWith("syntax:")
        ? resolved.syntax.text.foreground
        : resolved.colors[value.source as ColorsToken]
      : base.colors[key];
    if (resolved.colors[key] !== derived) colors[key] = resolved.colors[key];
  }
  const syntax: Partial<Record<SyntaxToken, Partial<SyntaxStyle>>> = {};
  for (const role of syntaxRoles) {
    const changed = Object.fromEntries(
      Object.entries(resolved.syntax[role]).filter(
        ([property, value]) => base.syntax[role][property as keyof SyntaxStyle] !== value,
      ),
    );
    if (Object.keys(changed).length) syntax[role] = changed;
  }
  const typography: Partial<Record<TypographyToken, Partial<Typography>>> = {};
  for (const role of typographyRoles) {
    const changed = Object.fromEntries(
      Object.entries(resolved.typography[role]).filter(
        ([property, value]) => !same(base.typography[role][property as keyof Typography], value),
      ),
    );
    if (Object.keys(changed).length) typography[role] = changed;
  }
  return tidy({
    id,
    name,
    mode: resolved.mode,
    ...(resolved.highContrast ? { highContrast: true } : {}),
    colors,
    syntax,
    typography,
    ...(same(resolved.effects.shadow, base.effects.shadow) ? {} : { effects: { shadow: resolved.effects.shadow } }),
  } as Theme);
}

/** Drops empty override groups so the schema and exported JSON stay minimal. */
function tidy(theme: Theme): Theme {
  for (const key of ["colors", "syntax", "typography"] as const) {
    const group = theme[key] as Record<string, object | string> | undefined;
    if (!group) continue;
    for (const [role, value] of Object.entries(group))
      if (typeof value === "object" && !Object.keys(value).length) delete group[role];
    if (!Object.keys(group).length) delete theme[key];
  }
  return theme;
}

export function newDraft(mode: "light" | "dark", takenPacks: Iterable<string>, name = "My Theme"): Draft {
  const id = slug(name);
  return {
    pack: {
      schemaVersion: 1,
      id: uniqueId(`custom.${id}`, takenPacks),
      name,
      version: "1.0.0",
      themes: [{ id, name, mode }],
    },
    themeId: id,
    installed: false,
  };
}

/** Copies one theme into a new standalone pack, keeping the source attribution and fonts. */
export function copyTheme(
  source: ThemePack,
  themeId: string,
  takenPacks: Iterable<string>,
  assets?: Record<string, Uint8Array>,
): Draft {
  const resolved = resolveTheme(source, themeId);
  const name = `${resolved.name} Copy`;
  const id = slug(name);
  return {
    pack: {
      schemaVersion: 1,
      id: uniqueId(`custom.${id}`, takenPacks),
      name,
      version: "1.0.0",
      ...(source.attribution ? { attribution: source.attribution } : {}),
      ...(source.fonts ? { fonts: structuredClone(source.fonts) } : {}),
      themes: [sparseTheme(resolved, id, name)],
    },
    themeId: id,
    installed: false,
    ...(assets ? { assets } : {}),
  };
}

export const editInstalled = (pack: ThemePack, themeId: string, assets: Record<string, Uint8Array>): Draft => ({
  pack: structuredClone(pack),
  themeId,
  installed: true,
  assets,
});

export const currentTheme = (draft: Draft) =>
  draft.pack.themes.find((theme) => theme.id === draft.themeId)!;

export function updateTheme(draft: Draft, change: (theme: Theme, pack: ThemePack) => void): Draft {
  const pack = structuredClone(draft.pack);
  const theme = pack.themes.find((item) => item.id === draft.themeId)!;
  change(theme, pack);
  tidy(theme);
  return { ...draft, pack };
}

export const setColor = (draft: Draft, key: ColorsToken, value?: string) =>
  updateTheme(draft, (theme) => {
    theme.colors = { ...theme.colors };
    if (value === undefined) delete theme.colors[key];
    else theme.colors[key] = value;
  });

export function setSyntax<K extends keyof SyntaxStyle>(draft: Draft, role: SyntaxToken, property: K, value?: SyntaxStyle[K]) {
  return updateTheme(draft, (theme) => {
    const style: Partial<SyntaxStyle> = { ...theme.syntax?.[role] };
    if (value === undefined) delete style[property];
    else style[property] = value;
    theme.syntax = { ...theme.syntax, [role]: style };
  });
}

export function setTypography<K extends keyof Typography>(draft: Draft, role: TypographyToken, property: K, value?: Typography[K]) {
  return updateTheme(draft, (theme) => {
    const font: Partial<Typography> = { ...theme.typography?.[role] };
    if (value === undefined) delete font[property];
    else font[property] = value;
    theme.typography = { ...theme.typography, [role]: font };
  });
}

export const setShadow = (draft: Draft, shadow?: Shadow[]) =>
  updateTheme(draft, (theme) => {
    if (shadow) theme.effects = { shadow: shadow as NonNullable<Theme["effects"]>["shadow"] };
    else delete theme.effects;
  });

/** Adds the opposite light/dark theme to the pack, pairs the two, and selects it. */
export function addVariant(draft: Draft): Draft {
  const theme = currentTheme(draft);
  const mode = theme.mode === "dark" ? "light" : "dark";
  const id = uniqueId(`${theme.id}-${mode}`, draft.pack.themes.map((item) => item.id));
  const name = `${theme.name} ${mode === "dark" ? "Dark" : "Light"}`;
  const next = updateTheme(draft, (current, pack) => {
    current.pairedTheme = id;
    pack.themes.push({ id, name, mode, pairedTheme: current.id });
  });
  return { ...next, themeId: id };
}

export function removeTheme(draft: Draft): Draft {
  if (draft.pack.themes.length < 2) return draft;
  const pack = structuredClone(draft.pack);
  pack.themes = pack.themes.filter((theme) => theme.id !== draft.themeId) as ThemePack["themes"];
  for (const theme of pack.themes) {
    if (theme.pairedTheme === draft.themeId) delete theme.pairedTheme;
    if (theme.base === draft.themeId) theme.base = `builtin:${theme.mode}`;
  }
  return { ...draft, pack, themeId: pack.themes[0].id };
}

/** Validation for the whole pack and, when valid, the resolved selected theme. */
export function check(draft: Draft) {
  const result = validatePack(draft.pack);
  return {
    ...result,
    resolved: result.valid ? resolveTheme(draft.pack, draft.themeId) : undefined,
  };
}
