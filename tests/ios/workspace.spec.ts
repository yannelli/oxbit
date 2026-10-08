import { expect, test } from "@playwright/test";
import { installBridge } from "./bridge.js";

test("switching iOS workspaces replaces panels before disposing the old session", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await installBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.locator(".cm-content")).toContainText("/device/Documents");
  await expect(page.getByRole("button", { name: "Language Servers: 1 running" })).toBeVisible();

  await page.locator(".workspace-title").click();
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.getByRole("dialog", { name: "Workspaces" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__iosTest.opened)).toBe(1);

  await page.locator(".workspace-title").click();
  await page.getByRole("button", { name: "Open Folder…", exact: true }).click();
  await expect(page.locator(".workspace-title")).toHaveText("Second");
  await expect(page.locator(".cm-content")).toContainText("/device/Second");
  await expect(page.getByRole("button", { name: "Language Servers: 1 running" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__iosTest.closed)).toEqual([
    { id: "/device/Documents", title: "Second" },
  ]);
  await page.getByRole("button", { name: "Language Servers: 1 running" }).click();
  await expect(page.getByRole("dialog", { name: "Language Servers", exact: true })).toContainText("Language intelligence is active");
  await page.getByRole("button", { name: "Close Language Servers" }).click();
  await page.screenshot({ path: "evidence/ios-language/workspace-switched.png" });
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await page.getByText("settings.jsonc", { exact: true }).click();
  await page.getByRole("button", { name: "Editor actions", exact: true }).click();
  const format = page.getByRole("menuitem", { name: "Format Document", exact: true });
  await expect(format).toBeEnabled();
  await format.click();
  await expect(page.locator(".cm-content")).toContainText('{ "enabled": true }');
  await expect(page.locator(".cm-content")).toContainText("// Keep comments");
  await page.screenshot({ path: "evidence/ios-language/jsonc-formatted.png" });
  expect(errors).toEqual([]);
});
