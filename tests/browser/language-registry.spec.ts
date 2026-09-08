import { test, expect } from "@playwright/test";
test("status follows the active document and local intelligence works offline", async ({ page }) => {
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    for (const [path, text] of [["language-status.ini", "[server]\nport=3000\n"], ["language-status.csv", 'name,notes\nRyan,"hello, world"\n']]) {
      const previous = await app.runtime.request("fs.read", { path }).catch(() => null);
      await app.runtime.request("fs.write", { path, text, expectedRevision: previous?.revision ?? null });
    }
    await app.openFile("language-status.ini");
  });
  const indicator = page.getByRole("button", { name: /^Language Servers:/ });
  await indicator.click();
  const popup = page.getByRole("dialog", { name: "Language Servers", exact: true });
  await expect(popup.locator(".lsp-server-name strong")).toHaveText("Oxbit ini");
  await expect(popup.locator(".lsp-server")).toHaveCount(1);
  await expect(popup.locator(".lsp-server-state")).toHaveText("Running");
  await popup.press("Escape");
  await expect(popup).toHaveCount(0);
  await page.evaluate(() => (window as any).__oxbit.openFile("language-status.csv"));
  await indicator.click();
  await expect(popup.locator(".lsp-server-name strong")).toHaveText("Oxbit csv");
  await expect(popup.locator(".lsp-server")).toHaveCount(1);
  await expect(popup).not.toContainText("Oxbit ini");
  await popup.press("Escape");
  await expect(popup).toHaveCount(0);
  await page.evaluate(() => (window as any).__oxbit.runtime.trust(false));
  await expect(indicator).toHaveAccessibleName("Language Servers: 1 running");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await indicator.click();
  await expect(popup).toBeVisible();
  await expect(popup.locator(".lsp-server-state")).toHaveText("Running");
  await popup.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(indicator).toBeFocused();
});
