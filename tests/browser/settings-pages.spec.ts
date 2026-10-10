import { expect, test, type Page } from "@playwright/test";

const shots = "evidence/settings-ui";

async function openSettings(page: Page, url = "/") {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(() => (window as any).__oxbit.workbench.run("settings.open"));
  await expect(page.getByRole("textbox", { name: "Search settings" })).toBeVisible();
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Setting categories" });

test("settings open on the first page and list the active page's sections", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSettings(page);
  const pages = await nav(page).locator(":scope > button:not(.settings-nav-section, .settings-nav-keyboard)").allTextContents();
  expect(pages.slice(0, 6)).toEqual(["Appearance", "Editor", "Formatting", "Files", "Terminal", "Source Control"]);
  expect(pages).not.toContain("All Settings");
  await expect(nav(page).getByRole("button", { name: "Appearance", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".settings-page-title")).toHaveText(["Appearance"]);
  await expect(page.getByRole("combobox", { name: "Color Theme", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage Theme Packs" })).toBeVisible();
  await expect(page.locator(".setting-id")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/desktop-appearance.png` });

  await nav(page).getByRole("button", { name: "Editor", exact: true }).click();
  await expect(nav(page).locator(".settings-nav-section")).toHaveText(["Typography", "Indentation"]);
  await expect(page.locator(".settings-section-title")).toHaveText(["Typography", "Indentation"]);
  await nav(page).getByRole("button", { name: "Indentation", exact: true }).click();
  await expect(page.locator('[data-section="Editor · Indentation"]')).toBeInViewport();

  const minimap = page.locator('[data-setting-id="editor.minimap"]');
  const toggle = minimap.getByRole("switch", { name: "Minimap" });
  await expect(minimap.getByRole("button", { name: "Reset Minimap" })).toHaveCount(0);
  const initial = await toggle.isChecked();
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: !initial });
  await expect(minimap).toHaveClass(/modified/);
  expect(await page.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.minimap"))).toBe(!initial);
  await minimap.getByRole("button", { name: "Reset Minimap" }).click();
  await expect(toggle).toBeChecked({ checked: initial });
  await expect(minimap.getByRole("button", { name: "Reset Minimap" })).toHaveCount(0);

  await minimap.hover();
  await minimap.getByRole("button", { name: "Copy setting ID" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("editor.minimap");
  await expect(page.locator(".notification, .toast").filter({ hasText: "Copied editor.minimap" }).first()).toBeVisible();

  await nav(page).getByRole("button", { name: "Keyboard Shortcuts" }).click();
  await expect(page.getByRole("heading", { name: "Keyboard Shortcuts", level: 1 })).toBeVisible();
});

test("search groups matches from every page by page and section", async ({ page }) => {
  await openSettings(page);
  const search = page.getByRole("textbox", { name: "Search settings" });
  await search.fill("font size");
  await expect(page.locator(".settings-page-title")).toHaveText(["Appearance", "Editor", "Terminal"]);
  await expect(page.locator(".settings-section-title")).toHaveText(["Typography"]);
  await expect(page.locator(".search-input .muted")).toHaveText("4 settings");
  await page.screenshot({ path: `${shots}/desktop-search.png` });
  await search.fill("indentation");
  await expect(page.locator(".settings-section-title")).toContainText(["Indentation"]);
  for (const id of ["editor.tabSize", "editor.insertSpaces", "editor.detectIndentation", "editor.renderIndentGuides"])
    await expect(page.locator(`[data-setting-id="${id}"]`)).toBeVisible();
  await search.fill("no-such-setting-anywhere");
  await expect(page.getByText("No matching settings")).toBeVisible();
  await search.fill("");
  await page.getByRole("checkbox", { name: "Modified", exact: true }).check();
  await expect(page.getByText("No matching settings")).toBeVisible();
  await page.evaluate(() => (window as any).__oxbit.kernel.configuration.set("terminal.scrollback", 2000));
  await expect(page.locator(".settings-page-title")).toHaveText(["Terminal"]);
  await expect(page.locator(".setting-row")).toHaveCount(1);
  await page.evaluate(() => (window as any).__oxbit.kernel.configuration.reset("terminal.scrollback"));
});

test("Edit as JSON applies only changed keys and rolls back a failed apply", async ({ page }) => {
  await openSettings(page);
  await page.evaluate(() => {
    const configuration = (window as any).__oxbit.kernel.configuration;
    configuration.set("editor.tabSize", 4);
    configuration.set("editor.minimap", false);
  });
  const layer = () => page.evaluate(() => (window as any).__oxbit.kernel.configuration.export().user);
  const open = async () => {
    await page.getByRole("button", { name: "Edit as JSON" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit as JSON" });
    await expect(dialog).toBeVisible();
    return { dialog, text: dialog.getByRole("textbox", { name: "Settings JSON" }) };
  };
  let { dialog, text } = await open();
  const original = JSON.parse(await text.inputValue());
  expect(original).toMatchObject({ "editor.tabSize": 4, "editor.minimap": false });
  const { "editor.minimap": _removed, ...rest } = original;
  await text.fill(JSON.stringify({ ...rest, "editor.tabSize": 6 }, null, 2));
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await layer()).toEqual({ ...rest, "editor.tabSize": 6 });

  ({ dialog, text } = await open());
  await text.fill(JSON.stringify({ ...rest, "editor.tabSize": 2, "editor.minimap": false, "editor.wordWrap": "sideways" }));
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByRole("alert")).toContainText("editor.wordWrap requires one of");
  expect(await layer()).toEqual({ ...rest, "editor.tabSize": 6 });
  await text.fill("{ not json");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => (window as any).__oxbit.kernel.configuration.reset("editor.tabSize"));
});

test("the Language Servers page lists each server with a switch and a Configure page with a chip editor", async ({ page }) => {
  await openSettings(page, "/#pair=oxbit-acceptance-2026");
  const expected = await page.evaluate(() => (window as any).__oxbit.kernel.extensions.list()
    .filter((record: any) => record.manifest.configuration?.some((setting: any) => setting.category?.startsWith("Language Servers · ")))
    .map((record: any) => record.manifest.name));
  expect(expected.length).toBeGreaterThan(0);
  await nav(page).getByRole("button", { name: "Language Servers", exact: true }).click();
  await expect(page.locator(".server-row .setting-title")).toHaveText(expected);
  await expect(page.locator('[data-setting-id="editor.semanticHighlighting"]')).toBeVisible();
  await expect(page.locator('[data-setting-id^="languageServer."]')).toHaveCount(0);
  await nav(page).getByRole("button", { name: "Servers", exact: true }).click();
  await expect(page.locator('[data-section="Language Servers · Servers"]')).toBeInViewport();
  await page.screenshot({ path: `${shots}/desktop-language-servers.png` });

  const name = "YAML Language Server", id = "oxbit.language-yaml";
  const state = () => page.evaluate(id => (window as any).__oxbit.kernel.extensions.list().find((record: any) => record.manifest.id === id).state, id);
  const toggle = page.getByRole("switch", { name, exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect.poll(state).toBe("disabled");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect.poll(state).toBe("active");

  const search = page.getByRole("textbox", { name: "Search settings" });
  await search.fill("File Types");
  await expect(page.locator(".settings-section-title")).toContainText(["YAML"]);
  await expect(page.locator('[data-setting-id="languageServer.yaml.fileTypes"]')).toBeVisible();
  await expect(page.locator(".server-row")).toHaveCount(0);
  await search.fill("yaml language");
  await expect(page.locator(".server-row .setting-title")).toHaveText([name]);
  await expect(toggle).toBeChecked();
  await search.fill("");
  await page.getByRole("button", { name: `Configure ${name}` }).click();
  await expect(page.getByRole("heading", { name: `${name} Settings` })).toBeVisible();
  await expect(page.locator(".settings-page-title, .settings-section-title")).toHaveCount(0);
  const fileTypes = page.getByRole("group", { name: "File Types", exact: true });
  const chips = fileTypes.locator(".setting-chip-item");
  const before = await chips.allTextContents();
  const add = fileTypes.getByRole("textbox", { name: "Add to File Types" });
  await add.fill("**/*.yaml.tmpl");
  await add.press("Enter");
  await expect(chips).toHaveText([...before, "**/*.yaml.tmpl"]);
  await expect(add).toHaveValue("");
  await add.fill(before[0]!);
  await fileTypes.getByRole("button", { name: "Add", exact: true }).click();
  await expect(chips).toHaveText([...before, "**/*.yaml.tmpl"]);
  await add.press("Enter");
  await expect(chips).toHaveCount(before.length + 1);
  await add.fill("x".repeat(1100));
  await add.press("Enter");
  await expect(page.locator('[data-setting-id="languageServer.yaml.fileTypes"] [role=alert]')).toContainText("File types must be");
  await expect(chips).toHaveCount(before.length + 1);
  await add.fill("");
  await fileTypes.getByRole("button", { name: "Remove **/*.yaml.tmpl" }).click();
  await expect(chips).toHaveText(before);
  await page.getByRole("button", { name: "Reset File Types" }).click();
  await expect(page.locator('[data-setting-id="languageServer.yaml.fileTypes"]')).not.toHaveClass(/modified/);
});
