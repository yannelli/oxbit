import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { htmlPreviewTests } from "./html-preview.js";
import { previewResourceTests } from "./preview-resources.js";

htmlPreviewTests();
previewResourceTests();

test("the iOS shell fills the screen after a stale keyboard accessory inset", async ({ page }) => {
  await ready(page);
  await page.addStyleTag({ content: await readFile(new URL("../../apps/ios/src/ios.css", import.meta.url), "utf8") });
  await page.evaluate(() => {
    const workbench = document.querySelector(".workbench")!;
    const shell = document.createElement("div");
    shell.className = "ios-shell";
    workbench.before(shell);
    shell.append(workbench);
  });
  await keyboardViewport(page, 500);
  await expect(page.locator(".workbench")).toHaveAttribute("data-keyboard", "1");
  await expect.poll(() => page.locator(".workbench").evaluate(element => element.getBoundingClientRect().height)).toBe(500);
  await keyboardViewport(page, 784);
  await expect(page.locator(".workbench")).not.toHaveAttribute("data-keyboard", "1");
  await expect.poll(() => page.locator(".activity-bar").evaluate(element => element.getBoundingClientRect().bottom)).toBe(852);
});

// Runs on the webkit-phone project only: a touch-first WebKit profile that approximates the
// iOS WKWebView shell before device checks.
async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await expect(page.locator(".cm-editor").first()).toBeVisible();
}

test("tapping an extension reveals its details above the mobile panels", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Extensions", exact: true }).tap();
  const card = page.locator(".extension-card").first();
  const title = await card.locator("strong").innerText();
  await card.tap();
  await expect(page.locator(".extension-details h1")).toHaveText(title);
  await expect(page.locator(".panel-dock")).toHaveCount(0);
  await page.getByRole("button", { name: "Extensions", exact: true }).tap();
  await card.tap();
  await expect(page.locator(".panel-dock")).toHaveCount(0);
});

test("split phone panels fill the space above navigation after the keyboard closes", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const root = document.querySelector(".workbench")!;
    const shell = document.createElement("div");
    shell.style.cssText = "height:100%;display:flex;flex-direction:column;position:relative";
    root.before(shell);
    shell.append(root);
    (root as HTMLElement).style.flex = "1";
    document.documentElement.style.setProperty("--safe-area-bottom", "34px");
    const workbench = (window as any).__oxbit.workbench;
    workbench.movePanel("scm", { container: "left", edge: "right" });
    workbench.openPanel("explorer");
  });
  await keyboardViewport(page, 500);
  await keyboardViewport(page, 852);
  const nav = page.locator(".activity-bar");
  await expect.poll(async () => {
    const top = (await nav.boundingBox())!.y;
    const bottoms = await page.locator(".panel-dock.sidebar .dock-group").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().bottom));
    return Math.max(...bottoms.map(bottom => Math.abs(top - bottom)));
  }).toBeLessThanOrEqual(1);
});

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

test("one bottom bar reserves the home inset once and keeps all touch targets aligned", async ({ page }, info) => {
  await ready(page);
  await page.addStyleTag({ content: ":root{--safe-area-bottom:34px}" });
  await page.evaluate(() => (window as any).__oxbit.workbench.set({ projectName: "A very long mobile workspace name" }));
  const nav = page.getByRole("navigation", { name: "Primary views" });
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 852 });
    await expect(page.locator(".statusbar")).toHaveCount(0);
    const buttons = nav.getByRole("button");
    await expect(buttons).toHaveCount(6);
    await expect.poll(() => nav.evaluate(element => element.getBoundingClientRect().bottom)).toBe(852);
    const bounds = (await nav.boundingBox())!;
    expect(bounds.height).toBe(90);
    const labels = await nav.locator(".phone-label").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
    expect(Math.max(...labels) - Math.min(...labels)).toBeLessThanOrEqual(1);
    for (const button of await buttons.all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y + box.height).toBeLessThanOrEqual(852 - 34);
    }
    for (const button of await page.locator(".titlebar button:visible").all()) {
      await insideViewport(button);
      expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.locator(".main-workbench").evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(bounds.y + 1);
    await nav.getByRole("button", { name: "Explorer", exact: true }).tap();
    const panel = page.locator(".panel-dock.sidebar:visible").first();
    expect((await panel.boundingBox())!.y + (await panel.boundingBox())!.height).toBeLessThanOrEqual(bounds.y + 1);
    await nav.getByRole("button", { name: "Explorer", exact: true }).tap();
  }
  await page.screenshot({ path: info.outputPath("phone-bottom-bar.png"), animations: "disabled" });
  await keyboardViewport(page, 400, 50);
  await expect.poll(() => nav.evaluate(element => element.getBoundingClientRect().height)).toBe(56);
  await insideViewport(nav);
});

test("extra tool panels stay in More without crowding phone navigation", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    (window as any).__oxbit.kernel.contributions.register({
      id: "phone-extra-view", kind: "activityView", title: "Phone extra view", component: () => null,
    });
  });
  const nav = page.getByRole("navigation", { name: "Primary views" });
  await expect(nav.getByRole("button")).toHaveCount(6);
  await nav.getByRole("button", { name: "More", exact: true }).tap();
  await page.getByRole("combobox").fill(">Open Phone extra view");
  await page.getByRole("option", { name: /Open Phone extra view/ }).tap();
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.workbench.panelVisible("phone-extra-view"))).toBe(true);
});

test("language status opens below the phone header and above the desktop footer", async ({ page }, info) => {
  await ready(page);
  const trigger = page.getByRole("button", { name: /^Language Servers:/ });
  const popup = page.getByRole("dialog", { name: "Language Servers", exact: true });
  await page.locator(".titlebar").getByRole("button", { name: /^Language Servers:/ }).tap();
  await insideViewport(popup);
  expect((await popup.boundingBox())!.y).toBeGreaterThanOrEqual((await trigger.boundingBox())!.y + (await trigger.boundingBox())!.height);
  await page.screenshot({ path: info.outputPath("phone-language-status.png"), animations: "disabled" });
  await popup.getByRole("button", { name: "Close Language Servers" }).tap();
  await keyboardViewport(page, 320, 80);
  await trigger.tap();
  await insideViewport(popup);
  await keyboardViewport(page, 852);
  await insideViewport(popup);
  await popup.getByRole("button", { name: "Close Language Servers" }).tap();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".statusbar").getByRole("button", { name: /^Language Servers:/ }).tap();
  await insideViewport(popup);
  const bounds = (await popup.boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThanOrEqual((await trigger.boundingBox())!.y);
});

test("phone gutters fit three-digit numbers and folding without desktop spacing", async ({ page }, info) => {
  await ready(page);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.filesystem.write("mobile-gutter.ts", "export function mobileFixture() {\n" + "  console.log('mobile');\n".repeat(150) + "}\n", { expectedRevision: null });
    await app.workbench.openFile("mobile-gutter.ts", { preview: false });
  });
  const closePanel = page.locator(".bottom-panel").getByRole("button", { name: "Close panel", exact: true }).first();
  if (await closePanel.isVisible()) await closePanel.tap();
  const gutter = page.locator(".cm-gutters").first();
  await expect.poll(() => gutter.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(42);
  expect(await page.locator(".cm-lineNumbers .cm-gutterElement").evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth))).toBe(true);
  await page.screenshot({ path: info.outputPath("phone-line-numbers.png"), animations: "disabled" });
  await page.locator('.cm-fold-marker[data-folded=false]:visible').first().tap();
  await expect(page.locator(".cm-foldPlaceholder")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => gutter.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(56);
});

test("file rows and menu labels resist selection while code and inputs remain selectable", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Explorer", exact: true }).tap();
  const row = page.locator('[role="treeitem"]').first();
  await hold(row);
  const menu = page.getByRole("menu");
  const label = menu.getByRole("menuitem", { name: /New File/ }).locator("span").first();
  await expect(label).toBeVisible();
  await page.evaluate(() => getSelection()?.removeAllRanges());
  const bounds = (await label.boundingBox())!;
  await page.mouse.move(bounds.x + 3, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2, { steps: 10 });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  expect(await row.evaluate(element => getComputedStyle(element).webkitUserSelect)).toBe("none");
  await page.mouse.up();
  await page.keyboard.press("Escape");
  // Opening a command while dragging its label may display its dialog.
  for (const close of await page.getByRole("button", { name: "Close dialog" }).all()) await close.tap();
  await page.getByRole("button", { name: "Explorer", exact: true }).tap();
  const code = page.locator(".cm-line").first();
  await code.dblclick({ position: { x: 25, y: 8 } });
  await expect.poll(() => page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Search files and commands", exact: true }).tap();
  const input = page.getByRole("combobox");
  await input.fill("selectable input");
  await input.press("ControlOrMeta+a");
  expect(await input.evaluate(element => (element as HTMLInputElement).selectionEnd! - (element as HTMLInputElement).selectionStart!)).toBe("selectable input".length);
});
