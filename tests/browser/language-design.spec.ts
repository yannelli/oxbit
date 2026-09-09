import { test, expect, type Page } from "@playwright/test";

async function ready(page: Page) {
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    // Other journeys intentionally replace acceptance.ts; give each hover test its own source.
    const path = `language-design-${crypto.randomUUID()}.ts`;
    await app.runtime.request("fs.write", {
      path,
      text: 'export const greeting: string = "hello";\nexport function welcome(name: string) { return greeting + name; }\nconst result = welcome("world");\n',
      expectedRevision: null,
    });
    await app.openFile(path);
  });
  for (const button of await page.locator(".toasts .icon-button").all()) await button.click();
}
const indicator = (page: Page) => page.getByRole("button", { name: /^Language Servers:/ });
async function hoverWelcome(page: Page) {
  await page.locator(".cm-content").first().focus();
  await page.mouse.move(20, 100);
  const symbol = page.locator(".cm-line").filter({ hasText: "export function welcome" }).locator("span").filter({ hasText: /^welcome$/ }).first();
  await symbol.hover();
  await expect(page.locator(".lsp-tooltip")).toBeVisible();
}

test("live language server controls and formatted hover survive a stop/start cycle", async ({ page }) => {
  await ready(page);
  await indicator(page).click();
  const popup = page.getByRole("dialog", { name: "Language Servers", exact: true });
  await expect(popup).toBeVisible();
  const start = popup.getByRole("button", { name: /^Start / });
  if (await start.isEnabled()) await start.click();
  await expect(indicator(page)).toHaveAccessibleName("Language Servers: 1 running");
  await expect(popup.locator(".lsp-server-state")).toHaveText("Running");
  await popup.getByRole("button", { name: /^Restart / }).click();
  await expect(popup.locator(".lsp-server-state")).toHaveText("Running");
  await page.screenshot({ path: "evidence/language-design/servers-dark.png" });
  await popup.getByRole("button", { name: /^Stop / }).click();
  await expect(indicator(page)).toHaveAccessibleName("Language Servers: 0 running");
  await expect(popup.locator(".lsp-server-state")).toHaveText("Stopped");
  await popup.press("Escape");
  await expect(indicator(page)).toBeFocused();
  await expect(popup).toHaveCount(0);
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n// still stopped");
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => {
    const app = (window as any).__oxbit;
    const service = app.kernel.services.get("language").serviceForPath(app.workbench.activePath());
    return app.runtime.request("lsp.status", service.transport.scope);
  });
  expect(state).toMatchObject({ state: "stopped", paused: true });
  await indicator(page).click();
  await popup.getByRole("button", { name: /^Start / }).click();
  await expect(indicator(page)).toHaveAccessibleName("Language Servers: 1 running");
  await popup.press("Escape");
  await hoverWelcome(page);
  await expect(page.locator(".lsp-tooltip pre code")).toContainText("function welcome(name: string): string");
  await expect(page.locator(".lsp-tooltip")).not.toContainText("```");
  await expect(page.locator(".lsp-tooltip .tok-keyword").first()).toBeVisible();
  await page.screenshot({ path: "evidence/language-design/hover-dark.png" });
  await page.evaluate(() => (window as any).__oxbit.kernel.configuration.set("workbench.colorTheme", "Paper (light)"));
  await hoverWelcome(page);
  await page.screenshot({ path: "evidence/language-design/hover-light.png" });
});

test("long documentation and status controls fit small viewports and support dismissal", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    const language = app.kernel.services.get("language").serviceForPath(app.workbench.activePath());
    await language.start(true);
    const at = language.at.bind(language);
    language.at = (method: string, ...args: any[]) => method === "textDocument/hover"
      ? Promise.resolve({ contents: { kind: "markdown", value: "```typescript\nfunction welcome(name: string): Promise<VeryLongReturnTypeWithDocumentation>\n```\n\nReturns a **friendly greeting** for the supplied `name`.\n\n- Handles Unicode names\n- Preserves whitespace\n\n[Documentation](https://example.com/docs)\n\n" + "Additional documentation paragraph.\n\n".repeat(35) } })
      : at(method, ...args);
  });
  await hoverWelcome(page);
  const hover = page.locator(".lsp-tooltip");
  await expect(hover.locator("strong")).toHaveText("friendly greeting");
  expect(await hover.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await hover.hover();
  await page.mouse.wheel(0, 180);
  await expect(hover).toBeVisible();
  await page.screenshot({ path: "evidence/language-design/long-hover.png" });
  await page.mouse.move(20, 100);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((width) => (window as any).__oxbit.kernel.configuration.set("workbench.colorTheme", width === 390 ? "Paper (light)" : "Graphite (dark)"), width);
    await indicator(page).click();
    const popup = page.getByRole("dialog", { name: "Language Servers", exact: true });
    await expect(popup).toBeVisible();
    const rect = (await popup.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    await popup.press("Tab");
    await expect(popup.getByRole("button", { name: "Close Language Servers" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(indicator(page)).toBeFocused();
    await indicator(page).click();
    await page.screenshot({ path: `evidence/language-design/servers-${width}.png` });
    await page.locator(".titlebar .brand").click();
    await expect(popup).toHaveCount(0);
  }
});

test("contributed servers appear individually and expose startup failures", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    (window as any).__oxbit.kernel.contributions.register({
      id: "fixture.language", kind: "transport", title: "Example Language Server",
      data: { languages: ["typescript"], createTransport: () => ({
        request: async (method: string) => { if (method === "initialize") throw new Error("Example server could not start"); return null; },
        notify() {}, onNotification: () => ({ dispose() {} }), dispose() {},
      }) },
    });
  });
  await indicator(page).click();
  const popup = page.getByRole("dialog", { name: "Language Servers", exact: true });
  const server = popup.getByRole("region", { name: "Example Language Server" });
  await expect(server.locator(".lsp-server-state")).toHaveText("Stopped");
  await server.getByRole("button", { name: "Start Example Language Server", exact: true }).click();
  await expect(server.locator(".lsp-server-state")).toHaveText("Failed");
  await expect(server.locator(".lsp-server-error")).toContainText("Example server could not start");
  await expect(server.getByRole("button", { name: "Retry Example Language Server", exact: true })).toBeEnabled();
  await expect(server.getByRole("button", { name: "Stop Example Language Server", exact: true })).toBeDisabled();
});
