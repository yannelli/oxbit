import { describe, expect, it } from "vitest";
import { resolveTheme, validatePack, type ThemePack } from "@oxbit/themes";
import { PackResources } from "../../../icon-themes/src/resources.js";
import { resolveDefinition } from "../../../icon-themes/src/resolver.js";
import { productIconIds } from "../../../ui/src/product-icons.js";
import pack from "./packs/oxbit.classicos98.json";
import { classicOS98Themes } from "./bundled.js";
import { classicOS98IconPack } from "./classicos98/index.js";

const themePack = pack as ThemePack;
const fileTheme = classicOS98IconPack.themes[0];
const productThemes = classicOS98IconPack.themes.slice(1);
const definition = (path: string, extra = {}) =>
  resolveDefinition(fileTheme.data, { path, ...extra }, "dark");

describe("ClassicOS 98 theme pack", () => {
  it("validates without errors or contrast warnings", () => {
    const result = validatePack(themePack);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("pairs every theme with a light or dark counterpart in the pack", () => {
    for (const theme of themePack.themes) {
      const paired = themePack.themes.find((t) => t.id === theme.pairedTheme);
      expect(paired, theme.id).toBeDefined();
      expect(paired!.mode, theme.id).not.toBe(theme.mode);
    }
  });

  it("keeps the Windows face colour and selection across every variant", () => {
    for (const theme of themePack.themes) {
      const resolved = resolveTheme(themePack, theme.id);
      expect(resolved.colors["surface.background"]).toBe(
        resolved.colors["workbench.background"],
      );
      expect(resolved.colors["selection.foreground"]).toBe(
        resolved.colors["editor.selection.foreground"],
      );
      expect(resolved.effects.shadow.every((s) => s.blur === 0)).toBe(true);
      expect(resolved.typography.body.family[0]).toBe("Tahoma");
    }
  });

  it("contributes each theme with the pack prefix", () => {
    expect(classicOS98Themes.map((item) => item.data.stableId)).toEqual(
      themePack.themes.map((theme) => `oxbit.classicos98/${theme.id}`),
    );
  });
});

describe("ClassicOS 98 icon pack", () => {
  it("loads under the same validators the runtime applies", async () => {
    const resources = new PackResources(classicOS98IconPack);
    await expect(resources.load()).resolves.toBeUndefined();
    resources.dispose();
  });

  it("uses a UUID revision, which the desktop store requires", () => {
    expect(classicOS98IconPack.revision).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
    );
    for (const theme of classicOS98IconPack.themes)
      expect(theme.id.startsWith(`${classicOS98IconPack.id}/`)).toBe(true);
  });

  it("resolves files, folders and the workspace root", () => {
    expect(definition("src/app.ts")).toBe("typescript");
    expect(definition("src/app.tsx")).toBe("react");
    expect(definition("README.md")).toBe("markdown");
    expect(definition("pnpm-lock.yaml")).toBe("lock");
    expect(definition("bun.lock")).toBe("lock");
    expect(definition("notes.unknown")).toBe("file");
    expect(definition("src", { folder: true })).toBe("folder");
    expect(definition("src", { folder: true, expanded: true })).toBe(
      "folderOpen",
    );
    expect(definition("proj", { folder: true, root: true })).toBe("drive");
  });

  it("covers every product icon the workbench asks for", () => {
    const wanted = [
      ...new Set(Object.values(productIconIds).filter((id) => id !== null)),
    ];
    for (const theme of productThemes)
      expect(
        wanted.filter((id) => !(id! in theme.data.iconDefinitions)),
        theme.id,
      ).toEqual([]);
    expect(productThemes.map((theme) => theme.kind)).toEqual([
      "productIconTheme",
      "productIconTheme",
    ]);
  });

  it("stores every referenced asset as validated SVG", () => {
    const referenced = classicOS98IconPack.themes.flatMap((theme) =>
      Object.values(theme.data.iconDefinitions).map((item) => item.iconPath!),
    );
    expect(referenced.filter((path) => !path)).toEqual([]);
    for (const path of referenced)
      expect(classicOS98IconPack.assets[path]?.mime).toBe("image/svg+xml");
    expect(Object.keys(classicOS98IconPack.assets).sort()).toEqual(
      [...new Set(referenced)].sort(),
    );
  });
});
