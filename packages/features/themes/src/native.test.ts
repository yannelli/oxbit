import { describe, expect, it } from "vitest";
import { languages } from "@oxbit/sdk";
import { PackResources } from "../../../icon-themes/src/resources.js";
import { resolveDefinition } from "../../../icon-themes/src/resolver.js";
import { rainbowAssociations } from "./rainbow/associations.js";
import { fileFamilies, folderFamilies } from "./native/families.js";
import { extensionGroups } from "./native/extensions.js";
import { fileNameGroups } from "./native/filenames.js";
import { folderNameGroups, languageIdGroups } from "./native/folders.js";
import { hasGlyph, hasLetters } from "./native/glyphs.js";
import { nativeAssociations, nativeIconPack } from "./native/index.js";

const theme = nativeIconPack.themes[0].data;
const resolve = (path: string, extra: { folder?: boolean; root?: boolean; languageId?: string } = {}, variant: "dark" | "light" = "dark") =>
  resolveDefinition(theme, { path, ...extra }, variant);

describe("Oxbit native icons", () => {
  it("draws every family from known glyphs and letters", () => {
    for (const [id, family] of Object.entries(fileFamilies)) {
      if (family.kind === "glyph") expect(hasGlyph(family.glyph), id).toBe(true);
      else if (family.kind === "test") expect(fileFamilies[family.base]?.kind, id).not.toBe("test");
      else expect(hasLetters(family.label), id).toBe(true);
    }
  });

  it("validates every SVG with the runtime resource checks", async () => {
    const resources = new PackResources(nativeIconPack);
    await expect(resources.load()).resolves.toBeUndefined();
    resources.dispose();
  });

  it("maps lowercase keys to known families, each key to one family", () => {
    const maps: [Record<string, string>, Record<string, unknown>][] = [
      [extensionGroups, fileFamilies], [fileNameGroups, fileFamilies], [languageIdGroups, fileFamilies], [folderNameGroups, folderFamilies],
    ];
    for (const [groups, families] of maps) {
      const owner = new Map<string, string>();
      for (const [id, keys] of Object.entries(groups)) {
        expect(families[id], id).toBeDefined();
        for (const key of keys.split(/\s+/).filter(Boolean)) {
          expect(key, id).toBe(key.toLowerCase());
          expect(owner.get(key) ?? id, `${key} in ${owner.get(key)} and ${id}`).toBe(id);
          owner.set(key, id);
        }
      }
    }
  });

  it("uses every family", () => {
    const used = new Set([...Object.values(nativeAssociations.fileExtensions), ...Object.values(nativeAssociations.fileNames), ...Object.values(nativeAssociations.languageIds)]);
    for (const id of Object.keys(fileFamilies)) if (id !== "file") expect(used.has(id), id).toBe(true);
    const folders = new Set(Object.values(nativeAssociations.folderNames));
    for (const id of Object.keys(folderFamilies)) if (id !== "folder" && id !== "root") expect(folders.has(id), id).toBe(true);
  });

  it("mirrors every dark association in light and high contrast", () => {
    for (const variant of ["light", "highContrast"] as const) {
      const override = theme[variant]!;
      for (const key of ["fileExtensions", "fileNames", "languageIds", "folderNames"] as const) {
        expect(Object.keys(override[key]!)).toEqual(Object.keys(theme[key]!));
        for (const [name, id] of Object.entries(override[key]!)) expect(id).toBe(theme[key]![name].replace(/^dark\./, `${variant}.`));
      }
      expect(resolveDefinition(theme, { path: "main.ts" }, variant)).toBe(`${variant}.typescript`);
      expect(resolveDefinition(theme, { path: "unknown-dir", folder: true }, variant)).toBe(`${variant}.folder.folder`);
    }
  });

  it("draws high contrast icons in colors that read on black and white", () => {
    const luminance = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    for (const [path, asset] of Object.entries(nativeIconPack.assets)) {
      if (!path.startsWith("icons/highContrast/")) continue;
      for (const [, color] of atob(asset.base64).matchAll(/(?:fill|stroke)="(#[0-9A-F]{6})"/gi)) {
        if (color.toUpperCase() === "#FFFFFF" || color === "#000000") continue;
        const l = luminance(color);
        expect(Math.min(1.05 / (l + 0.05), (l + 0.05) / 0.05), `${path} ${color}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("covers every association of the bundled packs and the language registry", () => {
    const covered = (source: Record<string, string>, target: Record<string, string>) => Object.keys(source).filter((key) => !Object.hasOwn(target, key));
    expect(covered(rainbowAssociations.fileExtensions, nativeAssociations.fileExtensions)).toEqual([]);
    expect(covered(rainbowAssociations.fileNames, nativeAssociations.fileNames)).toEqual([]);
    expect(covered(rainbowAssociations.languageIds, nativeAssociations.languageIds)).toEqual([]);
    expect(covered(rainbowAssociations.folderNames, nativeAssociations.folderNames)).toEqual([]);
    for (const language of languages) {
      expect(nativeAssociations.languageIds[language.id], language.id).toBeDefined();
      for (const ext of language.extensions) expect(resolve(`file.${ext}`), `${language.id}: ${ext}`).not.toBe("dark.file");
      for (const name of language.filenames ?? []) expect(resolve(name), `${language.id}: ${name}`).not.toBe("dark.file");
    }
  });

  it("resolves representative project files and folders", () => {
    const cases: [string, string, { folder?: boolean; root?: boolean; languageId?: string }?][] = [
      ["src/App.tsx", "typescriptreact"], ["src/index.test.ts", "test-typescript"], ["types/env.d.ts", "typescript-definition"],
      ["package.json", "npm"], ["tsconfig.json", "tsconfig"], ["Dockerfile", "docker"], ["Cargo.toml", "rust-manifest"],
      ["go.mod", "go-manifest"], ["vite.config.ts", "vite"], ["styles/app.scss", "sass"], ["photo.PNG", "image"],
      ["notes.unknownext", "file"], ["Dockerfile.ci", "docker", { languageId: "dockerfile" }],
      ["src", "folder.source", { folder: true }], ["node_modules", "folder.dependencies", { folder: true }],
      [".github", "folder.git", { folder: true }], ["unknown-dir", "folder.folder", { folder: true }], ["oxbit", "folder.root", { folder: true, root: true }],
    ];
    for (const [path, id, extra] of cases) expect(resolve(path, extra), path).toBe(`dark.${id}`);
  });
});
