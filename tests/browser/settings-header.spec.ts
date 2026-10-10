import { expect, test, type Page } from "@playwright/test";

async function openSettings(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(() => (window as any).__oxbit.workbench.run("settings.open"));
  await expect(page.getByRole("textbox", { name: "Search settings" })).toBeVisible();
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

for (const width of [393, 320]) {
  test(`a matching setting stays fully visible above the keyboard at ${width}px`, async ({ page }, info) => {
    test.skip(info.project.name !== "webkit-phone", "The keyboard viewport needs a coarse pointer.");
    await openSettings(page, width, 852);
    await page.getByRole("textbox", { name: "Search settings" }).fill("workbench.iconTheme");
    await keyboardViewport(page, 400);
    await expect(page.locator(".workbench")).toHaveAttribute("data-keyboard", "1");
    const row = page.locator('.setting-row[data-setting-id="workbench.iconTheme"]');
    await expect(row).toHaveCount(1);
    await expect.poll(() => row.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const heading = document.querySelector(".settings-heading")!.getBoundingClientRect();
      const view = element.closest(".document-view")!.getBoundingClientRect();
      const viewport = visualViewport!;
      return rect.top >= heading.bottom && rect.top >= view.top && rect.bottom <= view.bottom
        && rect.bottom <= viewport.offsetTop + viewport.height && rect.left >= 0 && rect.right <= innerWidth;
    })).toBe(true);
  });
}

for (const [width, height] of [[320, 852], [393, 852], [1280, 800]]) {
  test(`settings header controls share one height at ${width}px`, async ({ page }) => {
    await openSettings(page, width, height);
    const boxes = await page.locator(".settings-heading").evaluate(heading => {
      const bounds = heading.getBoundingClientRect();
      return [".settings-title-row>.button", ".search-input", ".settings-segmented", ".settings-scope .select-trigger", ".settings-chip"]
        .map(selector => {
          const rect = heading.querySelector(selector)!.getBoundingClientRect();
          return { selector, top: rect.top, height: rect.height, inside: rect.left >= bounds.left && rect.right <= bounds.right };
        });
    });
    for (const box of boxes) {
      expect(box.height, box.selector).toBeCloseTo(boxes[0].height, 0);
      expect(box.inside, box.selector).toBe(true);
    }
    const [select, chip] = boxes.slice(3);
    expect(select.top).toBeCloseTo(chip.top, 0);
  });
}

test("Git Accounts appears in Settings only while git.account is available", async ({ page }) => {
  await openSettings(page, 1280, 800);
  const button = page.getByRole("button", { name: "Manage Git Accounts…" });
  await expect(button).toHaveCount(0);
  await page.evaluate(() => {
    const app = (window as any).__oxbit;
    app.gitAccountRuns = 0;
    app.kernel.commands.register({ id: "git.account", title: "Git Accounts", run: () => { app.gitAccountRuns++; } });
  });
  const categories = page.getByRole("navigation", { name: "Setting categories" });
  await categories.getByRole("button", { name: "Source Control", exact: true }).click();
  await expect(button).toBeVisible();
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.gitAccountRuns)).toBe(1);
  const rows = page.locator(".settings-list > .setting-row");
  await expect(rows.first()).toContainText("Git Accounts and Commit Author");
  await expect(rows.nth(1)).toHaveAttribute("data-setting-id", "scm.autoFetch");
  await categories.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(button).toHaveCount(0);
});
