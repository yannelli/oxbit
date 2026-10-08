import { test, expect, type Page } from "@playwright/test";

const source = 'const count: number = "one";\nexport const total = count + 1;\n';
async function ready(page: Page) {
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  for (const button of await page.locator(".toasts .icon-button").all()) await button.click();
}
async function open(page: Page, path: string) {
  await page.evaluate(async (path) => {
    const app = (window as any).__oxbit;
    await app.openFile(path);
    await app.kernel.services.get("language").serviceForPath(path).start(true).catch(() => {});
  }, path);
}
const errors = (page: Page) => page.evaluate(() => (window as any).__oxbit.workbench.activeEditor().dom.querySelectorAll(".cm-lintRange-error").length);
async function completes(page: Page) {
  await page.evaluate(() => { const view = (window as any).__oxbit.workbench.activeEditor(); view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus(); });
  await page.keyboard.type("count.");
  const tooltip = page.locator(".cm-tooltip-autocomplete").filter({ hasText: "toFixed" });
  const shown = await tooltip.waitFor({ timeout: 15000 }).then(() => true, () => false);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const view = (window as any).__oxbit.workbench.activeEditor(), end = view.state.doc.length; view.dispatch({ changes: { from: end - 6, to: end } }); });
  return shown;
}
const indicator = (page: Page) => page.getByRole("button", { name: /^Language Servers:/ });
const popup = (page: Page) => page.getByRole("dialog", { name: "Language Servers", exact: true });
const fileSwitch = (page: Page) => popup(page).getByRole("switch", { name: "Language features for this file" });

test("turns language server features off and on for one file for the session", async ({ page }) => {
  await ready(page);
  const [first, second] = await page.evaluate(async (text) => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    const paths = [`toggle-a-${crypto.randomUUID()}.ts`, `toggle-b-${crypto.randomUUID()}.ts`];
    for (const path of paths) await app.runtime.request("fs.write", { path, text, expectedRevision: null });
    return paths;
  }, source);
  await open(page, second);
  await expect.poll(() => errors(page), { timeout: 30000 }).toBeGreaterThan(0);
  await open(page, first);
  await expect.poll(() => errors(page), { timeout: 30000 }).toBeGreaterThan(0);
  expect(await completes(page)).toBe(true);

  const savedSettings = await page.evaluate(() => JSON.stringify((window as any).__oxbit.kernel.configuration.get("languageServers") ?? {}));
  await indicator(page).click();
  await expect(fileSwitch(page)).toHaveAttribute("aria-checked", "true");
  await fileSwitch(page).click();
  await expect(fileSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(fileSwitch(page)).toHaveText("Off");
  await expect(popup(page)).toContainText("Language server features are off for this file.");
  await expect(indicator(page)).toHaveAccessibleName("Language Servers: off for this file");
  await popup(page).press("Escape");
  await expect.poll(() => errors(page)).toBe(0);
  expect(await page.evaluate((path) => (window as any).__oxbit.kernel.services.get("language").diagnostics.has(path), first)).toBe(false);
  expect(await completes(page)).toBe(false);
  expect(await page.evaluate(() => JSON.stringify((window as any).__oxbit.kernel.configuration.get("languageServers") ?? {}))).toBe(savedSettings);

  await open(page, second);
  await expect.poll(() => errors(page), { timeout: 30000 }).toBeGreaterThan(0);
  await expect(indicator(page)).toHaveAccessibleName(/^Language Servers: \d+ running$/);
  expect(await completes(page)).toBe(true);

  await page.evaluate((path) => (window as any).__oxbit.openFile(path), first);
  await expect(indicator(page)).toHaveAccessibleName("Language Servers: off for this file");
  expect(await errors(page)).toBe(0);
  await indicator(page).click();
  await fileSwitch(page).click();
  await expect(fileSwitch(page)).toHaveAttribute("aria-checked", "true");
  await popup(page).press("Escape");
  await expect.poll(() => errors(page), { timeout: 30000 }).toBeGreaterThan(0);
  expect(await completes(page)).toBe(true);

  await page.evaluate(() => (window as any).__oxbit.kernel.commands.execute("lsp.toggleFile"));
  await expect.poll(() => errors(page)).toBe(0);
  await page.reload();
  await ready(page);
  await open(page, first);
  expect(await page.evaluate((path) => (window as any).__oxbit.kernel.services.get("language").fileEnabled(path), first)).toBe(true);
  await expect.poll(() => errors(page), { timeout: 30000 }).toBeGreaterThan(0);
  await expect(indicator(page)).toHaveAccessibleName(/^Language Servers: \d+ running$/);
});

test("names the command for the active file state", async ({ page }) => {
  await ready(page);
  const titles = await page.evaluate(async (text) => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    const path = `toggle-command-${crypto.randomUUID()}.ts`;
    await app.runtime.request("fs.write", { path, text, expectedRevision: null });
    await app.openFile(path);
    const title = () => app.kernel.commands.list().find((command: { id: string }) => command.id === "lsp.toggleFile").title;
    const before = title();
    await app.kernel.commands.execute("lsp.toggleFile");
    return [before, title()];
  }, source);
  expect(titles).toEqual(["Disable Language Server for This File", "Enable Language Server for This File"]);
});
