import { expect, test, type Page } from "@playwright/test";

// Runs on the webkit-phone project only: a touch-first WebKit profile that approximates the
// iOS WKWebView shell before device checks.
async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await expect(page.locator(".cm-editor").first()).toBeVisible();
}

test("reports a coarse pointer and keeps the layout inside the viewport", async ({ page }) => {
  await ready(page);
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".workbench")).toHaveAttribute("data-mode", "phone");
});

test("editor tabs and explorer rows do not use HTML5 drag on touch", async ({ page }) => {
  await ready(page);
  await expect(page.locator(".editor-tab").first()).toHaveAttribute("draggable", "false");
  await page.getByRole("button", { name: "Explorer", exact: true }).tap();
  const row = page.locator('[role="treeitem"]').first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("draggable", "false");
});

test("a press held on an explorer row opens its context menu", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Explorer", exact: true }).tap();
  const row = page.locator('[role="treeitem"]').first();
  await expect(row).toBeVisible();
  await row.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true, pointerId: 7, clientX: rect.x + 20, clientY: rect.y + rect.height / 2 };
    element.dispatchEvent(new PointerEvent("pointerdown", init));
  });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Rename/ })).toBeVisible();
  await row.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", isPrimary: true, pointerId: 7 }));
  });
});

test("a moving touch does not open a context menu", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Explorer", exact: true }).tap();
  const row = page.locator('[role="treeitem"]').first();
  await expect(row).toBeVisible();
  await row.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true, pointerId: 8 };
    element.dispatchEvent(new PointerEvent("pointerdown", { ...base, clientX: rect.x + 20, clientY: rect.y + 10 }));
    element.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: rect.x + 20, clientY: rect.y + 60 }));
  });
  await page.waitForTimeout(700);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("the key bar stays hidden while no software keyboard covers the viewport", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (document.querySelector(".cm-content") as HTMLElement).focus());
  await expect(page.locator(".cm-content").first()).toBeFocused();
  await page.waitForTimeout(200);
  await expect(page.locator(".key-bar")).toHaveCount(0);
});
