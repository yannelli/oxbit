import { afterEach, describe, expect, it } from "vitest";
import { catalog } from "@oxbit/themes";
import { createKernel } from "../../../core/src/index.js";
import type { Kernel } from "@oxbit/sdk";
import {
  binxThemes,
  createFeature,
  loadBearingThemes,
  createVSCodeFeature,
  createVSCodeHighContrastFeature,
  vscodeThemes,
  vscodeHighContrastThemes,
} from "./index.js";

const kernels: Kernel[] = [];
async function setup() {
  const kernel = createKernel();
  kernels.push(kernel);
  kernel.configuration.register({
    id: "workbench.colorTheme",
    title: "Color Theme",
    type: "string",
    default: "Graphite (dark)",
  });
  kernel.extensions.register(createFeature({ kernel }));
  await kernel.extensions.trigger("onStartup");
  return kernel;
}
afterEach(() => kernels.splice(0).forEach((kernel) => kernel.dispose()));

describe("bundled theme families", () => {
  it("offers all variants without replacing the user's current theme", async () => {
    const kernel = await setup();
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "Graphite (dark)",
    );
    expect(
      kernel.contributions.list("theme").map((theme) => theme.title),
    ).toEqual([
      "Binx",
      "Binx Midnight",
      "Binx Moon",
      "Graphite (dark)",
      "Load Bearing (dark)",
      "Load Bearing (light)",
      "Paper (light)",
    ]);
  });

  it("selects from commands and toggles within each family", async () => {
    const kernel = await setup();
    await kernel.commands.execute("theme.loadBearing.light");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.load-bearing/load-bearing-light",
    );
    await kernel.commands.execute("theme.toggle");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.load-bearing/load-bearing-dark",
    );
    await kernel.commands.execute("theme.toggle");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.load-bearing/load-bearing-light",
    );
    await kernel.commands.execute("theme.loadBearing.dark");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.load-bearing/load-bearing-dark",
    );
    kernel.configuration.set("workbench.colorTheme", "Graphite (dark)");
    await kernel.commands.execute("theme.toggle");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.core/paper",
    );
    await kernel.commands.execute("theme.toggle");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.core/graphite",
    );
  });

  it("cleans up and restores theme contributions and commands on disable/enable", async () => {
    const kernel = await setup();
    await kernel.extensions.disable("oxbit.themes");
    expect(kernel.contributions.list("theme")).toEqual([]);
    expect(kernel.commands.list()).toEqual([]);
    await kernel.extensions.activate("oxbit.themes");
    await kernel.commands.execute("theme.loadBearing.dark");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.load-bearing/load-bearing-dark",
    );
    expect(kernel.contributions.list("theme")).toHaveLength(7);
    await kernel.commands.execute("theme.binx-midnight");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.binx/binx-midnight",
    );
  });

  it.each(binxThemes)(
    "selects $title and toggles to the light fallback",
    async (theme) => {
      const kernel = await setup();
      await kernel.commands.execute(`theme.${theme.id.replace("oxbit.", "")}`);
      expect(kernel.configuration.get("workbench.colorTheme")).toBe(
        theme.data.stableId,
      );
      await kernel.commands.execute("theme.toggle");
      expect(kernel.configuration.get("workbench.colorTheme")).toBe(
        "oxbit.core/paper",
      );
    },
  );

  it("covers the host's palette without overriding its brand assets", () => {
    for (const theme of [
      ...loadBearingThemes,
      ...binxThemes,
      ...vscodeThemes,
      ...vscodeHighContrastThemes,
    ]) {
      for (const token of Object.values(catalog.colors))
        expect(theme.data.variables).toHaveProperty(token.css);
      expect(theme.data.variables).not.toHaveProperty("--brand-logo");
      expect(theme.data.variables).not.toHaveProperty("--brand-accent");
    }
  });

  it("keeps text, syntax, and accent labels at a 4.5:1 contrast ratio", () => {
    const luminance = (hex: string) => {
      const channels = hex
        .slice(1)
        .match(/../g)!
        .map((value) => {
          const channel = parseInt(value, 16) / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const contrast = (a: string, b: string) => {
      const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
      return (values[1] + 0.05) / (values[0] + 0.05);
    };
    for (const theme of [
      ...loadBearingThemes,
      ...binxThemes,
      ...vscodeHighContrastThemes,
    ]) {
      const tokens: Record<string, string> = theme.data.variables;
      for (const foreground of ["--fg", "--fg-2", "--fg-3", "--accent"])
        for (const background of [
          "--bg-app",
          "--bg-surface",
          "--bg-editor",
          "--bg-raised",
          "--bg-input",
        ])
          expect(
            contrast(tokens[foreground], tokens[background]),
            `${theme.title}: ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
      for (const [key, value] of Object.entries(tokens))
        if (/^--tok-[a-z]+$/.test(key) && value !== "transparent")
          expect(
            contrast(value, tokens["--bg-editor"]),
            `${theme.title}: ${key}`,
          ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens["--accent-fg"], tokens["--accent"]),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("VS Code theme packs", () => {
  async function setupPacks() {
    const kernel = await setup();
    kernel.extensions.register(createVSCodeFeature({ kernel }));
    kernel.extensions.register(createVSCodeHighContrastFeature({ kernel }));
    await kernel.extensions.trigger("onStartup");
    return kernel;
  }

  it("registers six standard and two high contrast themes without changing the selection", async () => {
    const kernel = await setupPacks();
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "Graphite (dark)",
    );
    expect(kernel.contributions.list("theme")).toHaveLength(15);
    expect(vscodeThemes).toHaveLength(6);
    expect(vscodeHighContrastThemes).toHaveLength(2);
  });

  it.each([...vscodeThemes, ...vscodeHighContrastThemes])(
    "selects and toggles $title within its pair",
    async (theme) => {
      const kernel = await setupPacks();
      await kernel.commands.execute(`theme.${theme.id.replace("oxbit.", "")}`);
      expect(kernel.configuration.get("workbench.colorTheme")).toBe(
        theme.data.stableId,
      );
      const pair = kernel.contributions
        .list("theme")
        .find((item) => item.id === theme.data.pairedTheme)!;
      expect((pair.data as { mode: string }).mode).not.toBe(theme.data.mode);
      await kernel.commands.execute("theme.toggle");
      expect(kernel.configuration.get("workbench.colorTheme")).toBe(
        (pair.data as { stableId: string }).stableId,
      );
      await kernel.commands.execute("theme.toggle");
      expect(kernel.configuration.get("workbench.colorTheme")).toBe(
        theme.data.stableId,
      );
    },
  );

  it("disables and restores the packs independently, including their commands", async () => {
    const kernel = await setupPacks();
    await kernel.extensions.disable("oxbit.themes-vscode");
    expect(kernel.contributions.list("theme")).toHaveLength(9);
    expect(
      kernel.commands.list().some((c) => c.id === "theme.vscode-dark-modern"),
    ).toBe(false);
    await kernel.commands.execute("theme.vscode-hc-light");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.vscode-hc/vscode-hc-light",
    );
    await kernel.extensions.activate("oxbit.themes-vscode");
    await kernel.extensions.disable("oxbit.themes-vscode-high-contrast");
    expect(kernel.contributions.list("theme")).toHaveLength(13);
    expect(
      kernel.commands.list().some((c) => c.id === "theme.vscode-hc-light"),
    ).toBe(false);
    await kernel.commands.execute("theme.vscode-dark-modern");
    expect(kernel.configuration.get("workbench.colorTheme")).toBe(
      "oxbit.vscode/vscode-dark-modern",
    );
    await kernel.extensions.activate("oxbit.themes-vscode-high-contrast");
    expect(kernel.contributions.list("theme")).toHaveLength(15);
  });

  it("preserves inherited Plus syntax, Modern surfaces, and 2026 overrides", () => {
    const variables = (title: string) =>
      vscodeThemes.find((t) => t.title === title)!.data.variables;
    const modern = variables("VS Code Dark Modern");
    const plus = variables("VS Code Dark+");
    const next = variables("VS Code 2026 Dark");
    expect(modern["--tok-function"]).toBe("#DCDCAA");
    expect(modern["--tok-function"]).toBe(plus["--tok-function"]);
    expect(modern["--bg-editor"]).toBe("#1F1F1F");
    expect(plus["--bg-editor"]).toBe("#1E1E1E");
    expect(next["--bg-editor"]).toBe("#121314");
    expect(next["--tok-function"]).toBe("#d2a8ff");
    expect(next["--tok-comment"]).toBe("#8b949e");
    expect(variables("VS Code Light Modern")["--tok-type"]).toBe("#267f99");
    expect(variables("VS Code 2026 Light")["--tok-function"]).toBe("#8250df");
  });

  it("keeps high contrast borders prominent and selections translucent", () => {
    for (const theme of vscodeHighContrastThemes) {
      const colors = theme.data.variables;
      expect(colors["--bd"]).toBe(
        theme.data.mode === "dark" ? "#6FC3DF" : "#0F4A85",
      );
      expect(colors["--sel"]).toBe(`${colors["--bd"]}38`);
      expect(colors["--shadow"]).toBe("none");
    }
  });
});
