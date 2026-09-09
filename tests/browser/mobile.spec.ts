import { expect, test, type Locator, type Page } from "@playwright/test";

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

async function hold(locator: Locator) {
  await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true,
      pointerId: 11, clientX: rect.x + 20, clientY: rect.y + rect.height / 2,
    }));
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  await locator.evaluate(element => element.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true, pointerType: "touch", isPrimary: true, pointerId: 11,
  })));
}

async function keyboardViewport(page: Page, height: number, offsetTop = 0) {
  // Headless WebKit has no OS keyboard. Exercise its resize/scroll contract explicitly.
  await page.evaluate(({ height, offsetTop }) => {
    Object.defineProperty(visualViewport, "height", { configurable: true, value: height });
    Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: offsetTop });
    visualViewport!.dispatchEvent(new Event("resize"));
    visualViewport!.dispatchEvent(new Event("scroll"));
  }, { height, offsetTop });
}

async function insideViewport(locator: Locator) {
  await expect.poll(() => locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const viewport = visualViewport!;
    return rect.top >= viewport.offsetTop - 1 && rect.bottom <= viewport.offsetTop + viewport.height + 1 &&
      rect.left >= 0 && rect.right <= innerWidth + 1;
  })).toBe(true);
}

test("a held toolbar button does not swallow its click or the next tap", async ({ page }) => {
  await ready(page);
  const search = page.getByRole("button", { name: "Search files and commands", exact: true });
  await hold(search);
  // Safari's synthesized click must survive an unhandled contextmenu.
  await search.evaluate(element => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await expect(page.getByRole("dialog", { name: "Quick Open" })).toBeVisible();
  await page.getByRole("button", { name: "Close palette" }).tap();
  await hold(search);
  await page.getByRole("button", { name: "More", exact: true }).tap();
  await expect(page.getByRole("dialog", { name: "Quick Open" })).toBeVisible();
});

test("a context menu action works on the first tap after a long press", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Explorer", exact: true }).tap();
  const row = page.locator('[role="treeitem"]').first();
  await hold(row);
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /Rename/ }).tap();
  await expect(page.getByRole("dialog", { name: /Rename/ })).toBeVisible();
});

test("phone palette clears the notch and home indicator and responds to one tap", async ({ page }, info) => {
  await ready(page);
  // Device emulation does not provide physical safe-area insets.
  await page.addStyleTag({ content: ":root{--safe-area-top:59px;--safe-area-bottom:34px}" });
  await page.getByRole("button", { name: "More", exact: true }).tap();
  const input = page.getByRole("combobox", { name: "Search files and commands" });
  await expect.poll(() => input.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(59);
  expect(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  const close = page.getByRole("button", { name: "Close palette" });
  await insideViewport(close);
  expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.locator(".palette-footer .push").evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(852 - 34);
  await expect(page.locator(".palette-results [aria-disabled=true]").first()).toBeDisabled();
  await page.screenshot({ path: info.outputPath("palette-safe-area.png"), animations: "disabled" });
  await page.getByRole("option", { name: "About Oxbit", exact: true }).tap();
  await expect(page.getByRole("dialog", { name: "About Oxbit" })).toBeVisible();
});

test("palette search and close remain reachable as the software keyboard moves", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "More", exact: true }).tap();
  await keyboardViewport(page, 360, 100);
  await insideViewport(page.getByRole("dialog", { name: "Quick Open" }));
  await insideViewport(page.getByRole("combobox"));
  await insideViewport(page.getByRole("button", { name: "Close palette" }));
  await page.getByRole("combobox").fill(">About Oxbit");
  await page.getByRole("option", { name: "About Oxbit", exact: true }).tap();
  await insideViewport(page.getByRole("dialog", { name: "About Oxbit" }));
  await page.getByRole("button", { name: "Close dialog" }).tap();
  await keyboardViewport(page, 852);
  await page.getByRole("button", { name: "More", exact: true }).tap();
  await insideViewport(page.getByRole("dialog", { name: "Quick Open" }));
});

test("connection and workspace dialogs stay usable on a narrow phone with a keyboard", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ready(page);
  await page.getByRole("button", { name: "Runtime connection", exact: true }).first().tap();
  await keyboardViewport(page, 280, 80);
  const dialog = page.getByRole("dialog", { name: "Runtime Connection" });
  await insideViewport(dialog);
  const connect = dialog.getByRole("button", { name: "Pair and connect", exact: true });
  await connect.scrollIntoViewIfNeeded();
  await insideViewport(connect);
  await insideViewport(dialog.getByRole("button", { name: "Close dialog" }));
  await page.screenshot({ path: info.outputPath("connection-keyboard.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Close dialog" }).tap();
  await page.locator(".workspace-title").tap();
  await insideViewport(page.getByRole("dialog", { name: "Open Workspace" }));
  const closeWorkspace = page.getByRole("dialog").getByRole("button", { name: "Close Workspace", exact: true });
  await closeWorkspace.scrollIntoViewIfNeeded();
  await insideViewport(closeWorkspace);
  await page.getByRole("button", { name: "Close dialog" }).tap();
});

test("restricted workspaces expose trust, show progress, and retain trust after reload", async ({ page }, info) => {
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected);
  await page.evaluate(() => (window as any).__oxbit.runtime.trust(false));
  const entry = page.locator(".workspace-trust");
  await expect(entry).toContainText("Trust workspace tools");
  await insideViewport(entry);
  await entry.tap();
  const dialog = page.getByRole("dialog", { name: "Runtime Connection" });
  const trust = dialog.getByRole("button", { name: "Trust workspace tools", exact: true });
  await insideViewport(trust);
  await page.screenshot({ path: info.outputPath("workspace-trust.png"), animations: "disabled" });
  // Delay the real RPC so pending feedback and duplicate-tap protection are observable.
  await page.evaluate(() => {
    const runtime = (window as any).__oxbit.runtime;
    const original = runtime.trust.bind(runtime);
    runtime.trust = async (trusted: boolean) => {
      await new Promise(resolve => setTimeout(resolve, 400));
      return original(trusted);
    };
  });
  await trust.tap();
  await expect(dialog.getByRole("button", { name: "Working…" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Revoke workspace trust" })).toBeVisible();
  await expect(entry).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__oxbit.kernel.context.get("trusted"))).toBe(true);
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected);
  await expect(entry).toHaveCount(0);
  await page.getByRole("button", { name: "Runtime connection", exact: true }).first().tap();
  await page.getByRole("button", { name: "Revoke workspace trust" }).tap();
  await expect(dialog.getByRole("button", { name: "Trust workspace tools", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).tap();
  await expect(entry).toBeVisible();
});
