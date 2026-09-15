import { describe, expect, it } from "vitest";
import { resolveTheme, validatePack, type ThemePack } from "@oxbit/themes";
import { PackResources } from "../../../icon-themes/src/resources.js";
import { resolveDefinition } from "../../../icon-themes/src/resolver.js";
import { productIconIds } from "@oxbit/ui";
import pack from "./packs/oxbit.creative.json";
import { creativeThemes } from "./bundled.js";
import { rainbowIconPack } from "./rainbow/index.js";

describe("Rainbow and retro themes", () => {
  it("validates palettes without contrast warnings and contributes all seven stable IDs", () => {
    const result = validatePack(pack);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(creativeThemes.map((t) => t.data.stableId)).toEqual(
      pack.themes.map((t) => "oxbit.creative/" + t.id),
    );
    expect(
      new Set(pack.themes.map((t) => t.colors["editor.background"])).size,
    ).toBe(7);
  });
  it("pairs Rainbow dark and light and supplies themed terminal colours", () => {
    for (const theme of pack.themes) {
      const resolved = resolveTheme(pack as ThemePack, theme.id);
      expect(resolved.colors["terminal.background"]).toBe(
        theme.colors["workbench.background"],
      );
      if (theme.id.startsWith("rainbow-")) {
        const opposite = pack.themes.find((t) => t.id === theme.pairedTheme)!;
        expect(opposite.mode).not.toBe(theme.mode);
        expect(opposite.pairedTheme).toBe(theme.id);
      }
    }
  });
});

describe("Rainbow Pride icons", () => {
  const files = rainbowIconPack.themes[0].data;
  it("validates every SVG using runtime resource checks", async () => {
    const resources = new PackResources(rainbowIconPack);
    await expect(resources.load()).resolves.toBeUndefined();
    resources.dispose();
  });
  it("meets JetBrains pack association coverage and covers every themeable control", () => {
    expect(Object.keys(files.fileExtensions!).length).toBeGreaterThanOrEqual(
      150,
    );
    expect(Object.keys(files.fileNames!).length).toBeGreaterThanOrEqual(87);
    expect(Object.keys(files.folderNames!).length).toBeGreaterThanOrEqual(14);
    const product = rainbowIconPack.themes[1].data.iconDefinitions;
    for (const id of Object.values(productIconIds))
      if (id) expect(product[id], id).toBeDefined();
    expect(rainbowIconPack.revision).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
    );
  });
  it("resolves every association to distinct light and dark resources", () => {
    for (const mode of ["dark", "light"] as const) {
      for (const a of [files, files.light!]) {
        for (const key of [
          "fileExtensions",
          "fileNames",
          "languageIds",
          "folderNames",
          "folderNamesExpanded",
        ] as const)
          for (const id of Object.values(a[key] ?? {}))
            expect(files.iconDefinitions[id], id).toBeDefined();
      }
      for (const [path, extra, suffix] of [
        ["src/app.ts", {}, "typescript"],
        ["app.spec.ts", {}, "test"],
        ["Dockerfile", {}, "docker"],
        ["README.md", {}, "markdown"],
        ["track.wav", {}, "audio"],
        ["notes.unknown", {}, "file"],
        ["src", { folder: true }, "folder.source"],
        ["src", { folder: true, expanded: true }, "folder.sourceOpen"],
        ["project", { folder: true, root: true }, "folder.workspace"],
      ] as const) {
        const id = resolveDefinition(files, { path, ...extra }, mode);
        expect(id).toBe(mode + "." + suffix);
        expect(
          rainbowIconPack.assets[files.iconDefinitions[id!].iconPath!],
        ).toBeDefined();
      }
    }
  });
});
