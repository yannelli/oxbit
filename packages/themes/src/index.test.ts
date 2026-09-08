import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { zipSync, strToU8 } from "fflate";
import {
  catalog,
  validatePack,
  parsePack,
  resolveTheme,
  cssVariables,
  terminalTheme,
  readPackFile,
  exportPack,
  ThemePackStore,
  type ThemePack,
  type ColorsToken,
} from "./index.js";
const pack = (): ThemePack => ({
  schemaVersion: 1,
  id: "test.pack",
  name: "Test",
  version: "1.0.0",
  themes: [{ id: "night", name: "Night", mode: "dark" }],
});
describe("theme contract", () => {
  it("keeps the owned color and font inventory current",()=>{execFileSync(process.execPath,["scripts/theme-coverage.mjs","--check"]);});
  it("keeps generated schema, types and standalone validator reproducible", () => {
    const paths = [
      "packages/themes/src/theme-pack.v1.schema.json",
      "apps/web/public/schemas/theme-pack.v1.schema.json",
      "packages/themes/src/theme-pack.generated.ts",
      "packages/themes/src/validate.generated.js",
      "packages/themes/src/tokens.generated.ts",
      "packages/ui/src/theme-defaults.generated.css",
      "docs/themes/tokens.md",
    ];
    const before = paths.map((p) => readFileSync(p, "utf8"));
    execFileSync(process.execPath, ["packages/themes/scripts/generate.mjs"]);
    expect(paths.map((p) => readFileSync(p, "utf8"))).toEqual(before);
    expect(before[3]).not.toMatch(/new Function|eval\(|require\(/);
  });
  it("resolves complete bases, property inheritance, family arrays and font axes", () => {
    const p = pack();
    p.themes[0].colors = { "editor.background": "#123456" };
    p.themes[0].typography = {
      editor: {
        size: 18,
        family: ["Parent", "monospace"],
        axes: { wght: 500, wdth: 90 },
      },
    };
    p.themes.push({
      id: "child",
      name: "Child",
      mode: "dark",
      base: "night",
      syntax: { keyword: { italic: true } },
      typography: {
        editor: { weight: 600, family: ["Child"], axes: { wght: 650 } },
      },
    });
    const r = resolveTheme(p, "child");
    expect(Object.keys(r.colors).sort()).toEqual(
      Object.keys(catalog.colors).sort(),
    );
    expect(r.colors["editor.background"]).toBe("#123456");
    expect(r.typography.editor).toMatchObject({
      size: 18,
      weight: 600,
      family: ["Child"],
      axes: { wght: 650, wdth: 90 },
    });
    expect(r.syntax.keyword.italic).toBe(true);
  });
  it.each([
    [
      "unsupported version",
      (p: any) => (p.schemaVersion = 2),
      "/schemaVersion",
    ],
    ["unknown property", (p: any) => (p.css = "body{}"), "/css"],
    [
      "CSS color",
      (p: any) =>
        (p.themes[0].colors = { "editor.background": "url(https://evil)" }),
      "/themes/0/colors/editor.background",
    ],
    [
      "duplicate",
      (p: any) => p.themes.push({ ...p.themes[0] }),
      "/themes/1/id",
    ],
    ["cycle", (p: any) => (p.themes[0].base = "night"), "/themes/0/base"],
    [
      "missing base",
      (p: any) => (p.themes[0].base = "absent"),
      "/themes/0/base",
    ],
    [
      "mode mismatch",
      (p: any) => (p.themes[0].base = "builtin:light"),
      "/themes/0/base",
    ],
    [
      "pair reference",
      (p: any) => (p.themes[0].pairedTheme = "missing"),
      "/themes/0/pairedTheme",
    ],
    ["empty themes", (p: any) => (p.themes = []), "/themes"],
    [
      "remote font",
      (p: any) => (p.fonts = [{ id: "font", path: "https://evil/font.woff2" }]),
      "/fonts/0/path",
    ],
  ] as const)("rejects %s with a file and pointer", (_name, change, path) => {
    const p = pack();
    change(p);
    const result = validatePack(p, "custom.json");
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "custom.json", path }),
      ]),
    );
  });
  it("reports JSON parse errors and warns about intentional low contrast", () => {
    expect(parsePack("{", "broken.json").errors[0].file).toBe("broken.json");
    const p = pack();
    p.themes[0].colors = {
      "text.primary": "#000000",
      "workbench.background": "#000000",
    };
    expect(validatePack(p)).toMatchObject({
      valid: true,
      warnings: expect.arrayContaining([
        expect.objectContaining({ severity: "warning" }),
      ]),
    });
  });
  it("routes a distinctive value for every color through the CSS and terminal adapters", () => {
    const p = pack();
    p.themes[0].colors = Object.fromEntries(
      Object.keys(catalog.colors).map((key, i) => [
        key,
        "#" + (0x123400 + i).toString(16),
      ]),
    );
    const r = resolveTheme(p, "night"),
      css = cssVariables(r),
      terminal = terminalTheme(r);
    for (const [key, entry] of Object.entries(catalog.colors)) {
      expect(css[entry.css]).toBe(p.themes[0].colors![key as ColorsToken]);
      if (key.startsWith("terminal.") && !key.startsWith("terminal.search."))
        expect(terminal[key.slice(9)]).toBe(r.colors[key as ColorsToken]);
    }
    expect(Object.keys(terminal)).toHaveLength(23);
  });
});
describe("local archives", () => {
  it("round trips JSON, ZIP, fonts and notices", () => {
    const p = pack();
    expect(readPackFile(exportPack(p, {}).bytes, "theme.json").pack).toEqual(p);
    p.fonts = [{ id: "local", path: "font.woff2" }];
    const assets = {
      "font.woff2": strToU8("wOF2test"),
      "LICENSE.txt": strToU8("MIT"),
    };
    const result = readPackFile(exportPack(p, assets).bytes, "theme.zip");
    expect(result.pack).toEqual(p);
    expect(result.assets).toEqual(assets);
  });
  it.each([
    "../evil",
    "/absolute",
    "C:/evil",
    "a/../evil",
    "a\\evil",
    "script.js",
    "LICENSE.exe",
  ])("rejects unsafe or undeclared %s", (path) => {
    const bytes = zipSync({
      "theme-pack.json": strToU8(JSON.stringify(pack())),
      [path]: strToU8("bad"),
    });
    expect(() => readPackFile(bytes, "pack.zip")).toThrow();
  });
  it("rejects duplicate paths before decompression", () => {
    const bytes = zipSync({
      "theme-pack.json": strToU8(JSON.stringify(pack())),
      "LICENSE.txt": strToU8("one"),
      "license.txt": strToU8("two"),
    });
    expect(() => readPackFile(bytes, "pack.zip")).toThrow(/duplicate/);
  });
  it("rejects symlinks, oversized advertised output and absent fonts", () => {
    const bytes = zipSync({
      "theme-pack.json": strToU8(JSON.stringify(pack())),
    });
    const v = new DataView(bytes.buffer);
    let central = 0;
    while (v.getUint32(central, true) !== 0x02014b50) central++;
    v.setUint32(central + 38, 0xa0000000, true);
    expect(() => readPackFile(bytes, "pack.zip")).toThrow(/Unsafe/);
    v.setUint32(central + 38, 0, true);
    v.setUint32(central + 24, 21 * 1024 * 1024, true);
    expect(() => readPackFile(bytes, "pack.zip")).toThrow(/limits/);
    const p = pack();
    p.fonts = [{ id: "local", path: "font.woff2" }];
    expect(() => readPackFile(strToU8(JSON.stringify(p)), "pack.json")).toThrow(
      /Missing/,
    );
    expect(() =>
      readPackFile(
        exportPack(p, { "font.woff2": strToU8("HTML") }).bytes,
        "pack.zip",
      ),
    ).toThrow(/signature/);
  });
});
describe("durable pack store", () => {
  const storage = () => {
    let data: unknown;
    let fail = false;
    return {
      fail: (value: boolean) => (fail = value),
      get: async <T>() => structuredClone(data) as T,
      set: async (_key: string, value: unknown) => {
        if (fail) throw new Error("disk full");
        data = structuredClone(value);
      },
    };
  };
  it("publishes only committed writes, replaces IDs atomically, and restores a removed selection", async () => {
    const disk = storage(),
      store = new ThemePackStore(disk, new Set(["builtin"]));
    await store.load();
    let updates = 0;
    store.subscribe(() => updates++);
    const p = pack();
    await store.install(p);
    const after = updates;
    disk.fail(true);
    p.version = "2.0.0";
    await expect(store.install(p)).rejects.toThrow("disk full");
    expect(updates).toBe(after);
    expect(store.list()[0].pack.version).toBe("1.0.0");
    disk.fail(false);
    await store.install(p);
    expect(store.list()).toHaveLength(1);
    await store.enable(p.id, false);
    expect(store.resolve("test.pack/night")).toBeUndefined();
    expect(store.mode("test.pack/night")).toBe("dark");
    await store.remove(p.id);
    expect(store.list()).toEqual([]);
    await store.install(p);
    expect(store.resolve("test.pack/night")?.name).toBe("Night");
    const restored = new ThemePackStore(disk);
    await restored.load();
    expect(restored.list()).toEqual(store.list());
    await expect(store.install({ ...p, id: "builtin" })).rejects.toThrow(
      /Built-in/,
    );
  });
  it("merges writes from separate sessions and retains last known mode after reload", async () => {
    const disk = storage(),
      one = new ThemePackStore(disk),
      two = new ThemePackStore(disk);
    await Promise.all([one.load(), two.load()]);
    await one.install(pack());
    await two.install({ ...pack(), id: "second" });
    await one.reload();
    expect(one.list()).toHaveLength(2);
    await two.remove("test.pack");
    await one.reload();
    expect(one.mode("test.pack/night")).toBe("dark");
    expect(one.resolve("test.pack/night")).toBeUndefined();
  });
});
