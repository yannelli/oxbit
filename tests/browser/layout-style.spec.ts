import { test, expect, type Page } from "@playwright/test";

const ready = async (page: Page) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
};
const setStyle = (page: Page, style: string) =>
  page.evaluate((style) => (window as any).__oxbit.kernel.configuration.set("workbench.style", style), style);
const layout = (page: Page) =>
  page.evaluate(() => {
    const editor = document.querySelector(".editor-group")!.getBoundingClientRect();
    const sidebar = document.querySelector(".panel-dock.sidebar")!.getBoundingClientRect();
    const label = document.querySelector(".section-label")!;
    return {
      root: document.documentElement.dataset.style,
      workbench: document.querySelector(".workbench")!.getAttribute("data-style"),
      gap: Math.round(editor.left - sidebar.right),
      transform: getComputedStyle(label).textTransform,
      stored: localStorage.getItem("oxbit.layoutStyle"),
    };
  });

// Settings persist on the shared e2e runtime, so later specs need flat back even when a step fails.
test.afterEach(async ({ page }) => {
  await setStyle(page, "flat").catch(() => {});
});

test("Layout Style defaults to flat and switches to classic cards and back", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__oxbit.workbench.openPanel("explorer"));
  await expect.poll(() => layout(page)).toEqual({ root: "flat", workbench: "flat", gap: 0, transform: "none", stored: "flat" });

  await setStyle(page, "classic");
  await expect.poll(() => layout(page)).toMatchObject({ root: "classic", workbench: "classic", transform: "uppercase", stored: "classic" });
  expect((await layout(page)).gap).toBeGreaterThan(0);

  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  expect(await page.evaluate(() => document.documentElement.dataset.style)).toBe("classic");

  await setStyle(page, "flat");
  await expect.poll(() => layout(page)).toMatchObject({ root: "flat", gap: 0, transform: "none", stored: "flat" });
});

test("Settings lists Layout Style under Appearance with readable choices", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__oxbit.runCommand("settings.open"));
  const row = page.locator(".setting-row", { hasText: "Layout Style" });
  await expect(row).toBeVisible();
  await row.getByRole("combobox").click();
  await expect(page.getByRole("option", { name: "Flat" })).toBeVisible();
  await page.getByRole("option", { name: "Classic" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.style)).toBe("classic");
  await setStyle(page, "flat");
});
