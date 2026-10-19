import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatePack } from "@oxbit/themes";
import pack from "./packs/oxbit.vivid.json";
import { vividThemes } from "./bundled.js";

const css = readFileSync(
  new URL("../../../ui/src/vivid.css", import.meta.url),
  "utf8",
);

describe("Vivid themes", () => {
  it("validates without contrast warnings and contributes dark and light Nova, Lagoon, and Ember", () => {
    const result = validatePack(pack);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(vividThemes.map((t) => t.data.stableId)).toEqual(
      pack.themes.map((t) => "oxbit.vivid/" + t.id),
    );
    expect(pack.themes.map((t) => t.name)).toEqual([
      "Nova (dark)",
      "Nova (light)",
      "Lagoon (dark)",
      "Lagoon (light)",
      "Ember (dark)",
      "Ember (light)",
    ]);
  });

  it("pairs each family across modes", () => {
    for (const theme of pack.themes) {
      const paired = pack.themes.find((t) => t.id === theme.pairedTheme)!;
      expect(paired.mode).not.toBe(theme.mode);
      expect(paired.pairedTheme).toBe(theme.id);
    }
  });

  it("upgrades every theme's accent to Display P3 on wide-gamut screens", () => {
    expect(css).toContain("@media (color-gamut:p3)");
    for (const theme of pack.themes) {
      const rule = css.match(
        new RegExp(`\\[data-theme-id="oxbit\\.vivid/${theme.id}"\\]\\{([^}]*)\\}`),
      )?.[1];
      expect(rule, theme.id).toMatch(/--accent:color\(display-p3 [^)]+\)!important/);
      expect(rule, theme.id).toMatch(/--tok-keyword:color\(display-p3 /);
    }
  });
});
