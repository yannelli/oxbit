import { expect, test } from "@playwright/test";
import { installBridge } from "./bridge.js";

test("device workspaces search and quick open through the native host", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await installBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.locator(".cm-content")).toContainText("/device/Documents");

  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "More", exact: true }).tap();
  await page.getByRole("button", { name: "Search", exact: true }).tap();
  const panel = page.locator(".feature-search");
  await panel.getByRole("textbox", { name: "Search files", exact: true }).fill("workspace");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("listitem")).toContainText("example.ts");

  await page.getByRole("button", { name: "Search files and commands", exact: true }).tap();
  const palette = page.getByRole("dialog", { name: "Quick Open" });
  await palette.getByRole("combobox", { name: "Search files and commands" }).fill("sjc");
  await expect(palette.getByRole("option", { name: /settings\.jsonc/ })).toBeVisible();
  await palette.getByRole("option", { name: /settings\.jsonc/ }).click();
  await expect(page.locator(".cm-content")).toContainText("// Keep comments");

  const searches = await page.evaluate(() => (window as any).__iosTest.searches);
  expect(searches).toEqual(expect.arrayContaining([
    { method: "search", params: expect.objectContaining({ query: "workspace" }) },
    { method: "files", params: { query: "sjc" } },
  ]));
  expect(errors).toEqual([]);
});
