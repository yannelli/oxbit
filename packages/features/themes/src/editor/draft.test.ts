import { describe, expect, it } from "vitest";
import { builtinBase, resolveTheme, validatePack, type ThemePack } from "@oxbit/themes";
import { bundledPacks } from "../bundled.js";
import {
  addVariant,
  check,
  copyTheme,
  editInstalled,
  expandColor,
  newDraft,
  pickColor,
  removeTheme,
  setColor,
  setShadow,
  setSyntax,
  setTypography,
  slug,
  uniqueId,
} from "./draft.js";

const core = bundledPacks.find((pack) => pack.id === "oxbit.core")!;

describe("theme editor drafts", () => {
  it("starts a new pack with a unique ID that validates", () => {
    const draft = newDraft("dark", ["custom.my-theme"]);
    expect(draft.pack.id).toBe("custom.my-theme-2");
    expect(draft.installed).toBe(false);
    expect(validatePack(draft.pack).valid).toBe(true);
    expect(check(draft).resolved?.colors).toEqual(builtinBase("dark").colors);
  });

  it("copies a bundled theme as sparse overrides that resolve to the same theme", () => {
    for (const pack of bundledPacks)
      for (const theme of pack.themes) {
        const draft = copyTheme(pack, theme.id, bundledPacks.map((item) => item.id));
        const source = resolveTheme(pack, theme.id);
        const copy = check(draft).resolved!;
        expect(draft.pack.id.startsWith("custom.")).toBe(true);
        expect(copy.colors).toEqual(source.colors);
        expect(copy.syntax).toEqual(source.syntax);
        expect(copy.typography).toEqual(source.typography);
        expect(copy.effects).toEqual(source.effects);
        expect(copy.highContrast).toBe(source.highContrast);
      }
  });

  it("leaves derived colors out so they follow their source color", () => {
    const draft = copyTheme(core, core.themes[0].id, []);
    const changed = setColor(draft, "editor.background", "#102030");
    const resolved = check(changed).resolved!;
    expect(changed.pack.themes[0].colors).not.toHaveProperty("editor.gutter.background");
    expect(resolved.colors["editor.gutter.background"]).toBe("#102030");
    expect(resolved.colors["terminal.background"]).toBe("#102030");
  });

  it("sets and resets overrides without leaving empty groups", () => {
    let draft = newDraft("light", []);
    draft = setColor(draft, "accent.primary", "#ff0066");
    draft = setSyntax(draft, "keyword", "weight", 700);
    draft = setTypography(draft, "editor", "size", 15);
    draft = setShadow(draft, [{ x: 0, y: 2, blur: 4, spread: 0, color: "#0000004d" }]);
    expect(check(draft).resolved?.syntax.keyword.weight).toBe(700);
    expect(check(draft).resolved?.typography.editor.size).toBe(15);
    draft = setColor(draft, "accent.primary");
    draft = setSyntax(draft, "keyword", "weight");
    draft = setTypography(draft, "editor", "size");
    draft = setShadow(draft);
    expect(draft.pack.themes[0]).toEqual({ id: "my-theme", name: "My Theme", mode: "light" });
  });

  it("adds a paired light/dark variant and removes it again", () => {
    const draft = addVariant(newDraft("dark", []));
    expect(draft.themeId).toBe("my-theme-light");
    expect(draft.pack.themes.map((theme) => [theme.mode, theme.pairedTheme])).toEqual([
      ["dark", "my-theme-light"],
      ["light", "my-theme"],
    ]);
    expect(check(draft).valid).toBe(true);
    const removed = removeTheme(draft);
    expect(removed.pack.themes).toEqual([{ id: "my-theme", name: "My Theme", mode: "dark" }]);
  });

  it("edits an installed pack in place with its assets", () => {
    const pack: ThemePack = { schemaVersion: 1, id: "user.ink", name: "Ink", version: "1.0.0", themes: [{ id: "night", name: "Night", mode: "dark" }] };
    const assets = { "LICENSE.txt": new Uint8Array([1]) };
    const draft = editInstalled(pack, "night", assets);
    expect(draft).toMatchObject({ installed: true, assets, themeId: "night" });
    expect(setColor(draft, "text.primary", "#ffffff").assets).toBe(assets);
    expect(pack.themes[0].colors).toBeUndefined();
  });

  it("keeps alpha when a color picker sets the RGB part", () => {
    expect(pickColor("#ffffff0e", "#336699")).toBe("#3366990e");
    expect(pickColor("#abc", "#336699")).toBe("#336699");
    expect(pickColor("transparent", "#336699")).toBe("#33669900");
    expect(expandColor("#abcd")).toBe("#aabbccdd");
  });

  it("makes schema-safe IDs", () => {
    expect(slug("  Ink & Paper!  ")).toBe("ink-paper");
    expect(slug("***")).toBe("theme");
    expect(uniqueId("a", ["a", "a-2"])).toBe("a-3");
  });
});
