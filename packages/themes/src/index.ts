import catalog from "./catalog.json";
import generatedValidator from "./validate.generated.js";
const validateStructure = generatedValidator as typeof generatedValidator & {
  errors?: {
    instancePath: string;
    params: Record<string, string>;
    message?: string;
  }[];
};
import type { ThemePack } from "./theme-pack.generated.js";
import type {
  ColorsToken,
  SyntaxToken,
  TypographyToken,
} from "./tokens.generated.js";
export { catalog };
export { default as schema } from "./theme-pack.v1.schema.json";
export type { ThemePack, ColorsToken, SyntaxToken, TypographyToken };
export type Theme = ThemePack["themes"][number];
export interface Typography {
  family: string[];
  size: number;
  weight: number;
  style: "normal" | "italic" | "oblique";
  lineHeight: number;
  letterSpacing: number;
  ligatures: boolean;
  axes: Record<string, number>;
}
export interface SyntaxStyle {
  foreground: string;
  background: string;
  weight: number;
  italic: boolean;
  underline: boolean;
}
export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}
export interface ResolvedTheme {
  id: string;
  packId: string;
  localId: string;
  name: string;
  mode: "light" | "dark";
  highContrast: boolean;
  terminalFamilyExplicit?: boolean;
  pairedTheme?: string;
  colors: Record<ColorsToken, string>;
  syntax: Record<SyntaxToken, SyntaxStyle>;
  typography: Record<TypographyToken, Typography>;
  effects: { shadow: Shadow[] };
}
export interface ThemeDiagnostic {
  file: string;
  path: string;
  message: string;
  severity: "error" | "warning";
}
export interface ValidationResult {
  valid: boolean;
  errors: ThemeDiagnostic[];
  warnings: ThemeDiagnostic[];
  pack?: ThemePack;
}
const pointer = (value: string) =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");
export const themeId = (packId: string, localId: string) =>
  `${packId}/${localId}`;
export function validatePack(
  input: unknown,
  file = "theme-pack.json",
): ValidationResult {
  const errors: ThemeDiagnostic[] = [],
    warnings: ThemeDiagnostic[] = [];
  const error = (path: string, message: string) =>
    errors.push({ file, path, message, severity: "error" });
  if (!validateStructure(input)) {
    for (const item of validateStructure.errors ?? []) {
      const params = item.params as {
        additionalProperty?: string;
        missingProperty?: string;
      };
      error(
        item.instancePath +
          (params.additionalProperty || params.missingProperty
            ? "/" +
              pointer(params.additionalProperty || params.missingProperty!)
            : ""),
        item.message ?? "Invalid value",
      );
    }
    return { valid: false, errors, warnings };
  }
  const pack = input as ThemePack;
  const ids = new Set<string>(),
    fonts = new Set<string>();
  pack.fonts?.forEach((font, i) => {
    if (fonts.has(font.id)) error(`/fonts/${i}/id`, "Duplicate font ID");
    fonts.add(font.id);
    if (!safeAssetPath(font.path))
      error(
        `/fonts/${i}/path`,
        "Expected a relative asset path without traversal",
      );
  });
  pack.themes.forEach((theme, i) => {
    if (ids.has(theme.id)) error(`/themes/${i}/id`, "Duplicate theme ID");
    ids.add(theme.id);
  });
  pack.themes.forEach((theme, i) => {
    if (theme.pairedTheme && !ids.has(theme.pairedTheme))
      error(
        `/themes/${i}/pairedTheme`,
        "Paired theme does not exist in this pack",
      );
    const visited = new Set<string>();
    let current: Theme | undefined = theme;
    while (current) {
      if (visited.has(current.id)) {
        error(
          `/themes/${i}/base`,
          "Inheritance cycle: " + [...visited, current.id].join(" -> "),
        );
        break;
      }
      visited.add(current.id);
      const base: string = current.base ?? `builtin:${current.mode}`;
      if (base.startsWith("builtin:")) {
        if (base !== `builtin:${theme.mode}`)
          error(
            `/themes/${i}/base`,
            "Base must match the explicit light/dark mode",
          );
        break;
      }
      current = pack.themes.find((item) => item.id === base);
      if (!current) {
        error(`/themes/${i}/base`, `Missing base theme: ${base}`);
        break;
      }
      if (current.mode !== theme.mode) {
        error(`/themes/${i}/base`, "Cannot inherit across light/dark modes");
        break;
      }
    }
  });
  if (!errors.length)
    for (const [i, theme] of pack.themes.entries()) {
      const resolved = resolveUnchecked(pack, theme.id);
      for (const [fg, bg] of [
        ["text.primary", "workbench.background"],
        ["button.primary.foreground", "button.primary.background"],
        ["preview.foreground", "preview.background"],
      ] as const) {
        const ratio = contrast(resolved.colors[fg], resolved.colors[bg]);
        if (ratio !== undefined && ratio < 4.5)
          warnings.push({
            file,
            path: `/themes/${i}/colors/${pointer(fg)}`,
            message: `Contrast ${ratio.toFixed(2)}:1 against ${bg} (recommended 4.5:1).`,
            severity: "warning",
          });
      }
    }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ...(!errors.length ? { pack } : {}),
  };
}
export function parsePack(
  text: string,
  file = "theme-pack.json",
): ValidationResult {
  try {
    return validatePack(JSON.parse(text), file);
  } catch (e) {
    return {
      valid: false,
      warnings: [],
      errors: [
        {
          file,
          path: "",
          message: `Invalid JSON: ${String(e)}`,
          severity: "error",
        },
      ],
    };
  }
}
export function safeAssetPath(path: string) {
  return (
    !!path &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !path.includes("\0") &&
    path.split("/").every((p) => !!p && p !== "." && p !== "..")
  );
}
export function builtinBase(mode: "light" | "dark"): ResolvedTheme {
  return {
    id: `builtin:${mode}`,
    packId: "builtin",
    localId: mode,
    name: mode === "dark" ? "Graphite (dark)" : "Paper (light)",
    mode,
    highContrast: false,
    colors: Object.fromEntries(
      Object.entries(catalog.colors).map(([k, v]) => [k, v[mode]]),
    ) as ResolvedTheme["colors"],
    syntax: Object.fromEntries(
      Object.entries(catalog.syntax).map(([k, v]) => [
        k,
        {
          foreground: v[mode],
          background: "transparent",
          weight: k === "heading" || k === "strong" ? 700 : 400,
          italic: k === "emphasis",
          underline: false,
        },
      ]),
    ) as ResolvedTheme["syntax"],
    typography: structuredClone(
      Object.fromEntries(
        Object.entries(catalog.typography).map(([k, v]) => [k, v.default]),
      ),
    ) as ResolvedTheme["typography"],
    effects: { shadow: structuredClone(catalog.effects.shadow[mode]) },
  };
}
function resolveUnchecked(pack: ThemePack, id: string): ResolvedTheme {
  const theme = pack.themes.find((t) => t.id === id)!;
  const base =
    theme.base && !theme.base.startsWith("builtin:")
      ? resolveUnchecked(pack, theme.base)
      : builtinBase(theme.mode);
  Object.assign(base.colors, theme.colors);
  // Defaults for newly independent roles follow the palette unless explicitly inherited/overridden.
  const ancestors: Theme[] = [];
  let t: Theme | undefined = theme;
  while (t) {
    ancestors.push(t);
    t =
      t.base && !t.base.startsWith("builtin:")
        ? pack.themes.find((p) => p.id === t!.base)
        : undefined;
  }
  for (const [key, value] of Object.entries(catalog.colors))
    if (
      "source" in value &&
      !ancestors.some((t) => Object.hasOwn(t.colors ?? {}, key))
    ) {
      const source = value.source;
      base.colors[key as ColorsToken] = source.startsWith("syntax:")
        ? (theme.syntax?.text?.foreground ?? base.syntax.text.foreground)
        : base.colors[source as ColorsToken];
    }
  for (const [key, value] of Object.entries(theme.syntax ?? {}))
    Object.assign(base.syntax[key as SyntaxToken], value);
  for (const [key, value] of Object.entries(theme.typography ?? {}))
    Object.assign(base.typography[key as TypographyToken], value, {
      axes: { ...base.typography[key as TypographyToken].axes, ...value.axes },
    });
  if (theme.effects?.shadow)
    base.effects.shadow = structuredClone(theme.effects.shadow);
  return {
    ...base,
    id: themeId(pack.id, id),
    packId: pack.id,
    localId: id,
    name: theme.name,
    mode: theme.mode,
    highContrast: theme.highContrast ?? false,
    terminalFamilyExplicit: ancestors.some(
      (t) => !!t.typography?.terminal?.family,
    ),
    pairedTheme: theme.pairedTheme
      ? themeId(pack.id, theme.pairedTheme)
      : undefined,
  };
}
export function resolveTheme(pack: ThemePack, id: string): ResolvedTheme {
  const result = validatePack(pack);
  if (!result.valid) throw new Error(formatDiagnostics(result.errors));
  if (!pack.themes.some((t) => t.id === id))
    throw new Error(`theme-pack.json /themes: Missing theme ${id}`);
  return resolveUnchecked(pack, id);
}
export const formatDiagnostics = (items: ThemeDiagnostic[]) =>
  items.map((d) => `${d.file} ${d.path || "/"}: ${d.message}`).join("\n");
export function fontFamily(font: Typography) {
  return font.family
    .map((f) =>
      [
        "serif",
        "sans-serif",
        "monospace",
        "system-ui",
        "ui-monospace",
      ].includes(f)
        ? f
        : JSON.stringify(f),
    )
    .join(",");
}
export function typographyCSS(font: Typography): Record<string, string> {
  return {
    fontFamily: fontFamily(font),
    fontSize: `${font.size}px`,
    fontWeight: String(font.weight),
    fontStyle: font.style,
    lineHeight: String(font.lineHeight),
    letterSpacing: `${font.letterSpacing}px`,
    fontVariantLigatures: font.ligatures ? "normal" : "none",
    fontVariationSettings:
      Object.entries(font.axes)
        .map(([k, v]) => `"${k}" ${v}`)
        .join(",") || "normal",
  };
}
export function cssVariables(theme: ResolvedTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(catalog.colors))
    out[value.css] = theme.colors[key as ColorsToken];
  for (const [key, value] of Object.entries(catalog.syntax)) {
    const s = theme.syntax[key as SyntaxToken];
    out[value.css] = s.foreground;
    out[value.css + "-background"] = s.background;
    out[value.css + "-weight"] = String(s.weight);
    out[value.css + "-style"] = s.italic ? "italic" : "normal";
    out[value.css + "-decoration"] = s.underline ? "underline" : "none";
  }
  for (const [role, font] of Object.entries(theme.typography))
    for (const [property, value] of Object.entries(typographyCSS(font)))
      out[
        `--font-${role}-${property.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`
      ] = value;
  out["--font-mono"] = fontFamily(theme.typography.mono);
  out["--shadow"] =
    theme.effects.shadow
      .map((s) => `${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`)
      .join(",") || "none";
  return out;
}
export function terminalTheme(theme: ResolvedTheme): Record<string, string> {
  return Object.fromEntries(
    Object.entries(theme.colors)
      .filter(
        ([k]) => k.startsWith("terminal.") && !k.startsWith("terminal.search."),
      )
      .map(([k, v]) => [k.slice(9), v]),
  );
}
export function terminalSearch(theme: ResolvedTheme) {
  return {
    matchBackground: theme.colors["terminal.search.background"],
    matchBorder: theme.colors["terminal.search.border"],
    matchOverviewRuler: theme.colors["terminal.search.border"],
    activeMatchBackground: theme.colors["terminal.search.activeBackground"],
    activeMatchBorder: theme.colors["terminal.search.border"],
    activeMatchColorOverviewRuler: theme.colors["terminal.search.border"],
  };
}
function contrast(a: string, b: string) {
  const luminance = (c: string) => {
    if (!/^#[\da-f]{6}$/i.test(c)) return undefined;
    const v = c
      .slice(1)
      .match(/../g)!
      .map((x) => parseInt(x, 16) / 255)
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return x === undefined || y === undefined
    ? undefined
    : (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** @deprecated Only catalogued color variables with valid values are accepted. */
export function legacyTheme(
  mode: "light" | "dark",
  variables: Record<string, unknown>,
): ResolvedTheme {
  const theme = builtinBase(mode);
  const valid = (v: unknown): v is string =>
    typeof v === "string" &&
    /^(#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|transparent)$/i.test(v);
  for (const [k, v] of Object.entries(catalog.colors))
    if (valid(variables[v.css]))
      theme.colors[k as ColorsToken] = variables[v.css] as string;
  for (const [k, v] of Object.entries(catalog.syntax))
    if (valid(variables[v.css]))
      theme.syntax[k as SyntaxToken].foreground = variables[v.css] as string;
  return theme;
}
export {
  ThemePackStore,
  type InstalledPack,
  type PackPersistence,
} from "./store.js";
export {
  readPackFile,
  exportPack,
  inspectArchive,
  validateFont,
  assetLimits,
} from "./assets.js";
