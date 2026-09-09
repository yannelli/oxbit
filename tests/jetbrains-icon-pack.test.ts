import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import type { IconVariant } from "@oxbit/sdk";
import { importPack } from "../packages/icon-themes/src/import.js";
import { resolveDefinition } from "../packages/icon-themes/src/resolver.js";
import { PackResources } from "../packages/icon-themes/src/resources.js";
import type { Pack, StoredTheme } from "../packages/icon-themes/src/types.js";

const archive = "examples/icon-packs/jetbrains-icons.zip";
let pack: Pack;
let auto: StoredTheme;
let light: StoredTheme;

const iconPath = (path: string, variant: IconVariant, extra = {}) => {
  const id = resolveDefinition(auto.data, { path, ...extra }, variant);
  return auto.data.iconDefinitions[id!]?.iconPath;
};

describe("JetBrains icon pack archive", () => {
  beforeAll(async () => {
    pack = await importPack(new Blob([await readFile(archive)]), "icons.zip");
    [auto, , light] = pack.themes;
  });

  it("imports as three file icon themes without warnings", () => {
    expect(pack.warnings).toEqual([]);
    expect(pack.id).toBe("oxbit.jetbrains-icons");
    expect(pack.themes.map((theme) => theme.id)).toEqual([
      "oxbit.jetbrains-icons/2023",
      "oxbit.jetbrains-icons/2023-dark",
      "oxbit.jetbrains-icons/2023-light",
    ]);
    for (const theme of pack.themes) expect(theme.kind).toBe("fileIconTheme");
  });

  it("loads under the same validators the runtime applies", async () => {
    const resources = new PackResources(pack);
    await expect(resources.load()).resolves.toBeUndefined();
    resources.dispose();
  });

  it("resolves files, folders and the workspace root", () => {
    expect(iconPath("src/app.ts", "dark")).toBe("icons/typeScript_dark.svg");
    expect(iconPath("src/App.tsx", "dark")).toBe("icons/tsx_dark.svg");
    expect(iconPath("Dockerfile", "dark")).toBe("icons/docker_dark.svg");
    expect(iconPath("README.md", "dark")).toBe("icons/markdown_dark.svg");
    expect(iconPath("notes.unknown", "dark")).toBe("icons/text_dark.svg");
    expect(iconPath("src", "dark", { folder: true })).toBe(
      "icons/folder_dark.svg",
    );
    expect(iconPath("proj", "dark", { folder: true, root: true })).toBe(
      "icons/module_dark.svg",
    );
    expect(iconPath("tests", "dark", { folder: true })).toBe(
      "icons/folderTest_dark.svg",
    );
  });

  it("serves the light artwork for every dark association", () => {
    for (const [name, options] of [
      ["src/app.ts", {}],
      ["Dockerfile", {}],
      ["src", { folder: true }],
      ["proj", { folder: true, root: true }],
    ] as const)
      expect(iconPath(name, "light", options), name).not.toMatch(/_dark\.svg$/);
  });

  it("keeps the spec extensions the upstream light theme omits", () => {
    expect(iconPath("app.spec.ts", "dark")).toBe("icons/tsTest_dark.svg");
    expect(iconPath("app.spec.ts", "light")).toBe("icons/tsTest.svg");
    expect(light.data.fileExtensions?.["spec.ts"]).toBeUndefined();
  });

  it("carries every referenced icon and the upstream license", () => {
    const referenced = new Set(
      pack.themes.flatMap((theme) =>
        Object.values(theme.data.iconDefinitions).map((item) => item.iconPath!),
      ),
    );
    for (const path of referenced)
      expect(pack.assets[path]?.mime).toBe("image/svg+xml");
    expect(pack.assets["LICENSE.md"]?.mime).toBe("text/plain");
    expect(Object.keys(pack.assets).sort()).toEqual(
      ["LICENSE.md", ...referenced].sort(),
    );
  });
});
