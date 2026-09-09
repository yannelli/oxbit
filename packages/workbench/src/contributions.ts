import {
  builtinBase,
  cssVariables,
  legacyTheme,
  type ResolvedTheme,
  type Typography,
  type TypographyToken,
} from "@oxbit/themes";
import type { Contribution, Kernel } from "@oxbit/sdk";
export function documentViewFor(
  kernel: Kernel,
  path: string,
  options: { binary?: boolean } = {},
): Contribution | undefined {
  return kernel.contributions.list("documentView").find((contribution) => {
    const data = contribution.data as
      | {
          default?: boolean;
          binary?: boolean;
          extensions?: string[];
          matches?: (path: string) => boolean;
        }
      | undefined;
    if (data?.default || !contribution.component) return false;
    if (options.binary && !data?.binary) return false;
    try {
      return (
        data?.matches?.(path) ||
        data?.extensions?.some((extension) =>
          path
            .toLowerCase()
            .endsWith(
              extension.startsWith(".")
                ? extension.toLowerCase()
                : "." + extension.toLowerCase(),
            ),
        )
      );
    } catch {
      return false;
    }
  });
}
/** A binary view reads the file itself, so the text document is never opened for it. */
export function isBinaryDocumentView(
  kernel: Kernel,
  contributionId: string | undefined,
): boolean {
  if (!contributionId) return false;
  const contribution = kernel.contributions
    .list("documentView")
    .find((item) => item.id === contributionId);
  return !!(contribution?.data as { binary?: boolean } | undefined)?.binary;
}
export function menuContributions(
  kernel: Kernel,
  location: string,
): Contribution[] {
  const counts = new Map<string, number>();
  return kernel.contributions.list("menu").filter((contribution) => {
    if (contribution.location !== location || !contribution.command)
      return false;
    const owner = contribution.owner || contribution.id;
    const count = counts.get(owner) || 0;
    counts.set(owner, count + 1);
    return ["explorer", "tab", "editor", "terminal", "scm", "problem"].includes(
      location,
    )
      ? count < 3
      : true;
  });
}
const lastModes = new WeakMap<Kernel, Map<string, "light" | "dark">>();
export function currentTheme(kernel: Kernel): ResolvedTheme {
  const id = kernel.configuration.get<string>("workbench.colorTheme");
  const selected = kernel.contributions
    .list("theme")
    .find(
      (t) =>
        t.id === id ||
        t.title === id ||
        (t.data as { stableId?: string })?.stableId === id,
    );
  const data = selected?.data as
    | {
        resolved?: ResolvedTheme;
        mode?: "light" | "dark";
        variables?: Record<string, unknown>;
      }
    | undefined;
  const modes = lastModes.get(kernel) ?? new Map();
  lastModes.set(kernel, modes);
  const mode =
    data?.mode ??
    kernel.services
      .optional<{ mode(id: string): "light" | "dark" | undefined }>(
        "themePacks",
      )
      ?.mode(id) ??
    modes.get(id) ??
    "dark";
  modes.set(id, mode);
  return (
    data?.resolved ??
    (data?.variables ? legacyTheme(mode, data.variables) : builtinBase(mode))
  );
}
export function themeMode(kernel: Kernel) {
  return currentTheme(kernel).mode;
}
export function themeTypography(
  kernel: Kernel,
  role: TypographyToken,
  language?: string,
): Typography {
  const theme = currentTheme(kernel);
  const font = structuredClone(theme.typography[role]);
  const prefix = role === "body" ? "ui" : role;
  const properties = {
    fontFamily: "family",
    fontSize: "size",
    fontWeight: "weight",
    fontStyle: "style",
    lineHeight: "lineHeight",
    letterSpacing: "letterSpacing",
    fontLigatures: "ligatures",
    fontVariations: "axes",
  } as const;
  for (const [setting, property] of Object.entries(properties)) {
    const value = kernel.configuration.inspect(
      `${prefix}.${setting}`,
      language,
    );
    if (value.explicit) {
      if (
        property === "family" &&
        typeof value.value === "string" &&
        value.value.trim()
      )
        font.family = value.value
          .split(",")
          .map((f) => f.trim().replace(/^['"]|['"]$/g, ""));
      else if (property !== "family") (font as any)[property] = value.value;
    }
  }
  if (
    role === "editor" &&
    kernel.configuration.inspect("editor.lineHeight", language).explicit
  )
    font.lineHeight =
      (Number(kernel.configuration.get("editor.lineHeight", language)) ||
        font.size * 1.55) / font.size;
  if (
    role === "terminal" &&
    !kernel.configuration.inspect("terminal.fontFamily").explicit &&
    !theme.terminalFamilyExplicit
  )
    font.family = themeTypography(kernel, "editor").family;
  return font;
}
export function themeVariables(kernel: Kernel): Record<string, string> {
  const theme = structuredClone(currentTheme(kernel));
  theme.typography.body = themeTypography(kernel, "body");
  return cssVariables(theme);
}
