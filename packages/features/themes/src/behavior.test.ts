import { afterEach, it, expect } from "vitest";
import { createKernel } from "../../../core/src/index.js";
import {
  currentTheme,
  themeTypography,
} from "../../../workbench/src/contributions.js";
import { resolveTheme, type ThemePack } from "@oxbit/themes";
import { migrateLegacyThemes } from "./manager.js";
import schema from "../../settings/src/schema.json";
import type { Kernel, Setting } from "@oxbit/sdk";
const kernels: Kernel[] = [];
function setup() {
  const kernel = createKernel();
  kernels.push(kernel);
  for (const setting of schema)
    kernel.configuration.register(setting as Setting);
  return kernel;
}
afterEach(() => kernels.splice(0).forEach((k) => k.dispose()));
const pack: ThemePack = {
  schemaVersion: 1,
  id: "test",
  name: "Test",
  version: "1.0.0",
  themes: [
    {
      id: "custom",
      name: "Shared name",
      mode: "light",
      typography: {
        editor: { size: 19, family: ["Custom", "monospace"] },
        body: { size: 16 },
      },
    },
  ],
};
it("preserves settings scope precedence and resetting restores theme fonts", () => {
  const kernel = setup();
  kernel.contributions.register({
    id: "test/custom",
    title: "Shared name",
    kind: "theme",
    data: {
      mode: "light",
      stableId: "test/custom",
      resolved: resolveTheme(pack, "custom"),
    },
  });
  kernel.configuration.set("workbench.colorTheme", "test/custom");
  expect(themeTypography(kernel, "editor").size).toBe(19);
  expect(themeTypography(kernel, "body").size).toBe(16);
  kernel.configuration.set("editor.fontSize", 14, "user");
  kernel.configuration.set("editor.fontSize", 15, "workspace");
  kernel.configuration.set("editor.fontSize", 17, "user", "typescript");
  expect(
    kernel.configuration.inspect("editor.fontSize", "typescript"),
  ).toMatchObject({
    value: 17,
    explicit: true,
    scope: "user",
    language: "typescript",
  });
  expect(themeTypography(kernel, "editor", "typescript").size).toBe(17);
  kernel.configuration.reset("editor.fontSize", "user", "typescript");
  kernel.configuration.reset("editor.fontSize", "workspace");
  kernel.configuration.reset("editor.fontSize", "user");
  expect(themeTypography(kernel, "editor", "typescript").size).toBe(19);
  expect(themeTypography(kernel, "terminal").family).toEqual([
    "Custom",
    "monospace",
  ]);
  kernel.configuration.set("terminal.fontFamily", "Other, monospace");
  expect(themeTypography(kernel, "terminal").family).toEqual([
    "Other",
    "monospace",
  ]);
  kernel.configuration.reset("terminal.fontFamily");
  expect(themeTypography(kernel, "terminal").family).toEqual([
    "Custom",
    "monospace",
  ]);
});
it("migrates explicit legacy names without changing their scope or writing defaults", () => {
  const kernel = setup();
  kernel.configuration.set(
    "workbench.colorTheme",
    "Paper (light)",
    "workspace",
  );
  kernel.configuration.set(
    "workbench.colorTheme",
    "Binx",
    "user",
    "typescript",
  );
  migrateLegacyThemes(kernel);
  const data = kernel.configuration.export() as any;
  expect(data.workspace["workbench.colorTheme"]).toBe("oxbit.core/paper");
  expect(data.userLanguages.typescript["workbench.colorTheme"]).toBe(
    "oxbit.binx/binx",
  );
  expect(data.user).not.toHaveProperty("workbench.colorTheme");
});
it("disambiguates display names, retains requested IDs and restores returning themes", () => {
  const kernel = setup();
  const contribution = {
    id: "test/custom",
    title: "Shared name",
    kind: "theme" as const,
    data: {
      mode: "light",
      stableId: "test/custom",
      resolved: resolveTheme(pack, "custom"),
    },
  };
  let registration = kernel.contributions.register(contribution);
  kernel.contributions.register({
    ...contribution,
    id: "other/custom",
    data: {
      ...contribution.data,
      stableId: "other/custom",
      resolved: resolveTheme({ ...pack, id: "other" }, "custom"),
    },
  });
  kernel.configuration.set("workbench.colorTheme", "test/custom");
  expect(currentTheme(kernel).id).toBe("test/custom");
  registration.dispose();
  expect(currentTheme(kernel).mode).toBe("light");
  expect(kernel.configuration.get("workbench.colorTheme")).toBe("test/custom");
  registration = kernel.contributions.register(contribution);
  expect(currentTheme(kernel).id).toBe("test/custom");
  registration.dispose();
});

it("uses a persisted fallback mode when the profile loads after the first render", () => {
  const kernel = setup();
  kernel.configuration.set("workbench.colorTheme", "missing/light");
  expect(currentTheme(kernel).mode).toBe("dark");
  kernel.services.register("themePacks", { mode: () => "light" });
  expect(currentTheme(kernel).mode).toBe("light");
  expect(kernel.configuration.get("workbench.colorTheme")).toBe(
    "missing/light",
  );
});
