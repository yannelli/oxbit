import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import type { ThemePack } from "../../packages/themes/src/theme-pack.generated.js";
import {
  zipSync,
  strToU8,
} from "../../packages/themes/node_modules/fflate/esm/browser.js";
const exportPack = (pack: ThemePack, assets: Record<string, Uint8Array>) => ({
  bytes: zipSync({
    "theme-pack.json": strToU8(JSON.stringify(pack)),
    ...assets,
  }),
});
const pack: ThemePack = {
  schemaVersion: 1,
  id: "test.visual",
  name: "Visual Pack",
  version: "1.0.0",
  themes: [
    {
      id: "night",
      name: "Distinctive Night",
      mode: "dark",
      pairedTheme: "day",
      colors: {
        "editor.background": "#16102a",
        "workbench.background": "#221133",
        "button.primary.background": "#e6adff",
        "button.primary.foreground": "#220033",
        "popover.background": "#39254f",
        "popover.foreground": "#f7e6ff",
        "editor.selection.foreground": "#ffff00",
        "terminal.background": "#102a22",
        "terminal.red": "#ff5577",
      },
      syntax: {
        keyword: { foreground: "#ff99ee", weight: 700 },
        emphasis: { italic: true },
        strong: { weight: 700 },
      },
      typography: {
        body: { family: ["serif"], size: 15 },
        editor: { family: ["monospace"], size: 18 },
        terminal: { size: 16 },
      },
    },
    {
      id: "day",
      name: "Distinctive Day",
      mode: "light",
      pairedTheme: "night",
      colors: { "editor.background": "#fff0fb" },
      typography: { body: { family: ["serif"], size: 15 } },
    },
  ],
};
async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__oxbit?.ready);
}
async function manage(page: Page) {
  await page.evaluate(() =>
    (window as any).__oxbit.runCommand("theme.packs.manage"),
  );
  await expect(
    page.getByRole("heading", { name: "Manage Theme Packs" }),
  ).toBeVisible();
}
async function importPack(
  page: Page,
  value: ThemePack = pack,
  bytes?: Uint8Array,
) {
  await manage(page);
  await page.getByLabel("Import Theme Pack", { exact: true }).setInputFiles({
    name: bytes ? "pack.zip" : "theme-pack.json",
    mimeType: bytes ? "application/zip" : "application/json",
    buffer: Buffer.from(bytes ?? JSON.stringify(value)),
  });
  await expect(
    page.getByRole("button", {
      name: `Apply ${value.themes[0].name}`,
      exact: true,
    }),
  ).toBeVisible();
}
async function selected(page: Page) {
  return page.evaluate(() =>
    (window as any).__oxbit.kernel.configuration.get("workbench.colorTheme"),
  );
}
test("imports without selection, applies typography, exports, updates, removes and restores across tabs", async ({
  page,
  context,
}) => {
  await ready(page);
  const previous = await selected(page);
  await importPack(page);
  expect(await selected(page)).toBe(previous);
  await page
    .getByRole("button", { name: "Apply Distinctive Night", exact: true })
    .click();
  expect(await selected(page)).toBe("test.visual/night");
  await expect(page.locator(".workbench")).toHaveCSS("font-family", "serif");
  await expect(page.locator(".workbench")).toHaveCSS(
    "background-color",
    "rgb(34, 17, 51)",
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export Visual Pack", exact: true })
    .click();
  const exported = await download;
  expect(JSON.parse(readFileSync((await exported.path())!, "utf8"))).toEqual(
    pack,
  );
  const second = await context.newPage();
  await ready(second);
  await manage(second);
  await expect(
    second.getByRole("button", {
      name: "Apply Distinctive Night",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove Visual Pack", exact: true })
    .click();
  await expect(
    second.getByRole("button", {
      name: "Apply Distinctive Night",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(await selected(page)).toBe("test.visual/night");
  await expect(page.locator(".workbench")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  await importPack(page);
  await expect(page.locator(".workbench")).toHaveCSS(
    "background-color",
    "rgb(34, 17, 51)",
  );
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oxbit?.ready);
  expect(await selected(page)).toBe("test.visual/night");
  await manage(page);
  const invalid = { ...pack, version: "2.0.0", css: "unsafe" };
  await page.getByLabel("Import Theme Pack", { exact: true }).setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "/css" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply Distinctive Night", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.configuration.set(
      "workbench.colorTheme",
      "test.visual/day",
    ),
  );
  await page
    .getByRole("button", { name: "Disable Visual Pack", exact: true })
    .click();
  await expect(page.locator(".workbench")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oxbit?.ready);
  await expect(page.locator(".workbench")).toHaveAttribute(
    "data-theme",
    "light",
  );
  expect(await selected(page)).toBe("test.visual/day");
  await manage(page);
  await page
    .getByRole("button", { name: "Enable Visual Pack", exact: true })
    .click();
  await expect(page.locator(".workbench")).toHaveCSS("--bg-editor", "#fff0fb");
});
test("mounted editor preserves state, syntax emphasis, selected foreground, and font reset", async ({
  page,
}) => {
  await ready(page);
  await importPack(page);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.workbench.openFile("README.md", { preview: false });
  });
  await page.waitForFunction(
    () =>
      (window as any).__oxbit.workbench.activePath() === "README.md" &&
      !!(window as any).__oxbit.workbench.activeEditor(),
  );
  await page.evaluate(() => {
    const z = (window as any).__oxbit;
    const doc = z.documents.get("README.md");
    doc.replace("# Theme test\n\n**Strong** and *emphasis* and ***both***\n");
    z.kernel.configuration.set("workbench.colorTheme", "test.visual/night");
    (window as any).__themeEditor = z.workbench.activeEditor();
  });
  await expect(page.locator(".cm-scroller").first()).toHaveCSS(
    "font-size",
    "18px",
  );
  await expect(
    page.locator(".cm-content").getByText("*emphasis*", { exact: true }),
  ).toHaveCSS("font-style", "italic");
  await expect(
    page.locator(".cm-content").getByText("**Strong**", { exact: true }),
  ).toHaveCSS("font-weight", "700");
  await expect(
    page
      .locator(".oxbit-syntax-strong.oxbit-syntax-emphasis")
      .filter({ hasText: "both" }),
  ).toHaveCSS("font-weight", "700");
  await expect(
    page
      .locator(".oxbit-syntax-strong.oxbit-syntax-emphasis")
      .filter({ hasText: "both" }),
  ).toHaveCSS("font-style", "italic");
  await page.evaluate(() => {
    const z = (window as any).__oxbit;
    z.kernel.configuration.set("editor.fontSize", 22);
  });
  await expect(page.locator(".cm-scroller").first()).toHaveCSS(
    "font-size",
    "22px",
  );
  await page.evaluate(() => {
    const z = (window as any).__oxbit;
    z.kernel.configuration.reset("editor.fontSize");
    z.workbench.activeEditor().dispatch({ selection: { anchor: 0, head: 6 } });
  });
  await expect(page.locator(".cm-scroller").first()).toHaveCSS(
    "font-size",
    "18px",
  );
  await expect(page.locator(".oxbit-selection-text").first()).toHaveCSS(
    "color",
    "rgb(255, 255, 0)",
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).__themeEditor ===
        (window as any).__oxbit.workbench.activeEditor(),
    ),
  ).toBe(true);
});
test("loads scoped local fonts and reports browser font failure with fallbacks", async ({
  page,
}) => {
  await ready(page);
  const custom: ThemePack = {
    ...pack,
    id: "test.font",
    name: "Font Pack",
    fonts: [{ id: "local-font", path: "font.ttf" }],
    themes: [
      {
        id: "font",
        name: "Font Theme",
        mode: "light",
        typography: {
          body: { family: ["local-font", "serif"] },
          editor: { family: ["local-font", "monospace"] },
        },
      },
    ],
  };
  const bytes = exportPack(custom, {
    "font.ttf": new Uint8Array(
      readFileSync("apps/web/public/fonts/oxbit-font-0.woff2"),
    ),
  }).bytes;
  await importPack(page, custom, bytes);
  await page
    .getByRole("button", { name: "Apply Font Theme", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some(
          (f) => f.family.startsWith("oxbit-") && f.status === "loaded",
        ),
      ),
    )
    .toBe(true);
  const broken = {
    ...custom,
    fonts: [{ id: "local-font", path: "font.woff2" }],
    id: "test.broken",
    name: "Broken Font",
    themes: [{ ...custom.themes[0], name: "Broken Theme" }],
  };
  await importPack(
    page,
    broken,
    exportPack(broken, { "font.woff2": new TextEncoder().encode("wOF2broken") })
      .bytes,
  );
  await page
    .getByRole("button", { name: "Apply Broken Theme", exact: true })
    .click();
  await expect(
    page.getByText(/Font could not load; using fallback/).first(),
  ).toBeVisible();
});
for (const [name, width, height] of [
  ["desktop", 1440, 900],
  ["tablet", 820, 1180],
  ["phone", 390, 844],
] as const)
  test(`light, dark and high contrast at ${name} size`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await ready(page);
    await importPack(page);
    mkdirSync("evidence/themes", { recursive: true });
    for (const id of [
      "test.visual/night",
      "test.visual/day",
      "oxbit.vscode-hc/vscode-hc-light",
    ]) {
      await page.evaluate(
        (id) =>
          (window as any).__oxbit.kernel.configuration.set(
            "workbench.colorTheme",
            id,
          ),
        id,
      );
      await expect(page.locator(".workbench")).toHaveAttribute(
        "data-theme",
        id.endsWith("night") ? "dark" : "light",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `evidence/themes/${name}-${id.split("/")[1]}.png`,
      });
    }
  });

test("terminal ANSI, selection and typography update without losing history", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:9290");
  await page.waitForFunction(() => !!(window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    await (window as any).__oxbit.connectRuntime(
      "http://127.0.0.1:9290",
      "oxbit-theme-test",
    );
    await (window as any).__oxbit.runtime.trust(true);
  });
  await importPack(page);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.runCommand("terminal.new");
    z.workbench.openPanel("terminal");
  });
  await expect(page.locator(".xterm-screen")).toBeVisible();
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    const session = [
      ...z.kernel.services.get("terminal").sessions.values(),
    ][0] as any;
    (window as any).__themeTerminal = session.terminal;
    await z.runtime.request("terminal.input", {
      id: session.id,
      data: "printf '\\nTHEME HISTORY\\n\\033[31mANSI RED\\033[0m\\n'\n",
    });
    z.kernel.configuration.set("workbench.colorTheme", "test.visual/night");
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__themeTerminal.options.theme.red),
    )
    .toBe("#ff5577");
  expect(
    await page.evaluate(() => (window as any).__themeTerminal.options.fontSize),
  ).toBe(16);
  await page.evaluate(() => {
    const z = (window as any).__oxbit;
    z.kernel.configuration.set("terminal.fontSize", 21);
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__themeTerminal.options.fontSize),
    )
    .toBe(21);
  await page.setViewportSize({ width: 820, height: 900 });
  await page.evaluate(() => {
    const z = (window as any).__oxbit;
    z.kernel.configuration.reset("terminal.fontSize");
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__themeTerminal.options.fontSize),
    )
    .toBe(16);
  expect(
    await page.evaluate(() => {
      const z = (window as any).__oxbit;
      const session = [
        ...z.kernel.services.get("terminal").sessions.values(),
      ][0] as any;
      const terminal = (window as any).__themeTerminal;
      return (
        session.terminal === terminal &&
        Array.from({ length: terminal.buffer.active.length }, (_, i) =>
          terminal.buffer.active.getLine(i)?.translateToString(),
        )
          .join("\n")
          .includes("THEME HISTORY")
      );
    }),
  ).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const terminal = (window as any).__themeTerminal;
        return Array.from({ length: terminal.buffer.active.length }, (_, i) =>
          terminal.buffer.active.getLine(i)?.translateToString().trim(),
        ).includes("ANSI RED");
      }),
    )
    .toBe(true);
  for (const button of await page
    .getByRole("button", { name: "Dismiss notification", exact: true })
    .all())
    await button.click();
  await page.screenshot({ path: "evidence/themes/terminal-ansi.png" });
});

test("rendered Markdown, popovers and keyboard focus use the selected theme", async ({
  page,
}) => {
  await ready(page);
  const previewPack: ThemePack = {
    ...pack,
    themes: [
      {
        ...pack.themes[0],
        pairedTheme: undefined,
        colors: {
          ...pack.themes[0].colors,
          "preview.background": "#203040",
          "preview.foreground": "#f0d0b0",
          "focus.border": "#ff44bb",
        },
        typography: {
          ...pack.themes[0].typography,
          document: { family: ["serif"], size: 20, lineHeight: 1.8 },
        },
      },
    ],
  };
  await importPack(page, previewPack);
  await page
    .getByRole("button", { name: "Apply Distinctive Night", exact: true })
    .click();
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.workbench.openFile("README.md", { preview: false });
  });
  await page
    .getByRole("button", { name: "Open Markdown preview", exact: true })
    .click();
  await expect(page.locator(".markdown-preview")).toHaveCSS(
    "background-color",
    "rgb(32, 48, 64)",
  );
  await expect(page.locator(".markdown-preview")).toHaveCSS(
    "font-size",
    "20px",
  );
  await page.evaluate(() =>
    (window as any).__oxbit.runCommand("settings.open"),
  );
  const theme = page.getByRole("combobox", {
    name: "Color Theme",
    exact: true,
  });
  await theme.scrollIntoViewIfNeeded();
  await theme.focus();
  await theme.press("ArrowDown");
  await expect(
    page.getByRole("listbox", { name: "Color Theme", exact: true }),
  ).toHaveCSS("background-color", "rgb(57, 37, 79)");
  await expect(
    page.getByRole("listbox", { name: "Color Theme", exact: true }),
  ).toHaveCSS("color", "rgb(247, 230, 255)");
  await theme.press("Escape");
  await expect(theme).toBeFocused();
  await expect(theme).toHaveCSS("outline-color", "rgb(255, 68, 187)");
});

test("bundled creative themes and Rainbow icons switch, pair and persist", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.workbench.openFile("README.md", { preview: false });
    z.documents
      .get("README.md")
      .replace(
        "# Pride & retro\n\nA workbench for everyone.\n\n**Bold ideas**, *clear code*.\n",
      );
  });
  const palettes = [
    ["rainbow-dark", "dark", "#181920"],
    ["rainbow-light", "light", "#fffafd"],
    ["camo", "dark", "#22271d"],
    ["terminal", "dark", "#09130d"],
    ["eighties", "dark", "#1c122f"],
    ["seventies", "light", "#fbf0d5"],
    ["fallout", "dark", "#1e2319"],
  ];
  for (const [id, mode, background] of palettes) {
    await page.evaluate(
      (id) => (window as any).__oxbit.runCommand("theme." + id),
      id,
    );
    await expect(page.locator(".workbench")).toHaveAttribute(
      "data-theme",
      mode,
    );
    await expect(page.locator(".workbench")).toHaveCSS(
      "--bg-editor",
      background,
    );
    const ribbon = await page.locator(".titlebar").evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return { background: style.backgroundImage, height: style.height, pointerEvents: style.pointerEvents };
    });
    if (id.startsWith("rainbow-")) {
      expect(ribbon.background).toContain("linear-gradient");
      expect(ribbon.height).toBe("4px");
      expect(ribbon.pointerEvents).toBe("none");
    } else expect(ribbon.background).toBe("none");
    await expect(page.locator(".cm-content").first()).toContainText(
      "A workbench for everyone.",
    );
    await page.screenshot({
      path: "/private/tmp/oxbit-creative-" + id + ".png",
    });
  }
  await page.evaluate(() =>
    (window as any).__oxbit.runCommand("theme.rainbow.dark.apply"),
  );
  const selectedIcons = () =>
    page.evaluate(() => {
      const c = (window as any).__oxbit.kernel.configuration;
      return [
        c.get("workbench.iconTheme"),
        c.get("workbench.productIconTheme"),
      ];
    });
  expect(await selectedIcons()).toEqual([
    "oxbit.rainbow-icons/files",
    "oxbit.rainbow-icons/controls",
  ]);
  await expect
    .poll(() => page.locator("img.themed-icon").count())
    .toBeGreaterThan(0);
  const broken = await page
    .locator("img.themed-icon")
    .evaluateAll((images: HTMLImageElement[]) =>
      Promise.all(
        images.map((image) =>
          image.decode().then(
            () => false,
            () => true,
          ),
        ),
      ),
    );
  expect(broken).not.toContain(true);
  await page.screenshot({
    path: "/private/tmp/oxbit-creative-rainbow-icons-dark.png",
  });
  await page.evaluate(() => (window as any).__oxbit.runCommand("theme.toggle"));
  expect(await selected(page)).toBe("oxbit.creative/rainbow-light");
  await expect(page.locator(".workbench")).toHaveAttribute(
    "data-theme",
    "light",
  );
  await page.screenshot({
    path: "/private/tmp/oxbit-creative-rainbow-icons-light.png",
  });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oxbit?.ready);
  expect(await selected(page)).toBe("oxbit.creative/rainbow-light");
  expect(await selectedIcons()).toEqual([
    "oxbit.rainbow-icons/files",
    "oxbit.rainbow-icons/controls",
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.services
      .get("iconThemes")
      .remove("oxbit.rainbow-icons"),
  );
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__oxbit?.ready);
  const installed = await page.evaluate(() =>
    (window as any).__oxbit.kernel.services
      .get("iconThemes")
      .list()
      .map((p: any) => p.id),
  );
  expect(installed).not.toContain("oxbit.rainbow-icons");
  expect(installed).toContain("oxbit.classicos98");
});
