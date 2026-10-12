import { test, expect, type Page } from "@playwright/test";

const align = (page: Page, value?: string) =>
  page.evaluate((value) => {
    const configuration = (window as any).__oxbit.kernel.configuration;
    if (value) configuration.set("workbench.panelAlignment", value);
    else configuration.reset("workbench.panelAlignment");
  }, value);

const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element || !(element as HTMLElement).offsetParent) return undefined;
      const rect = element.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
    };
    return {
      editor: box(".editor-groups"),
      left: box(".dock-left"),
      right: box(".dock-right"),
      bottom: box(".dock-bottom"),
      title: box(".titlebar"),
      status: box(".statusbar"),
    };
  });

test.afterEach(async ({ page }) => {
  await align(page);
});

test("the bottom panel spans under the sidebars it is aligned to", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await align(page);
  await page.evaluate(() => {
    const wb = (window as any).__oxbit.workbench;
    wb.movePanel("explorer", { container: "left" });
    wb.movePanel("search", { container: "right" });
    wb.openPanel("problems");
    const panels = wb.getPanelLayout();
    panels.docks.left.visible = true;
    panels.docks.right.visible = true;
    wb.set({ panelLayout: panels });
  });
  await expect(page.locator(".dock-left")).toBeVisible();
  await expect(page.locator(".dock-right")).toBeVisible();
  await expect(page.locator(".dock-bottom")).toBeVisible();

  type Layout = Awaited<ReturnType<typeof layout>>;
  const expected: Record<string, (l: Layout) => number[]> = {
    center: (l) => [l.editor!.left, l.editor!.right],
    left: (l) => [l.left!.left, l.editor!.right],
    right: (l) => [l.editor!.left, l.right!.right],
    justify: (l) => [l.left!.left, l.right!.right],
  };
  for (const [alignment, span] of Object.entries(expected)) {
    await align(page, alignment);
    await expect(page.locator(".workbench")).toHaveAttribute("data-panel-alignment", alignment);
    await expect.poll(async () => {
      const l = await layout(page), [start, end] = span(l);
      return {
        offset: [l.bottom!.left - start, l.bottom!.right - end],
        gapAbove: l.bottom!.top - l.editor!.bottom,
        gapBelow: l.status!.top - l.bottom!.bottom,
      };
    }, { message: alignment }).toEqual({ offset: [0, 0], gapAbove: 4, gapBelow: 4 });
    await expect(page.locator(".dock-bottom [role=tabpanel] .panel-instance")).toHaveCount(1);
  }

  await page.evaluate(() => (window as any).__oxbit.workbench.set({ maxPanel: true }));
  await expect.poll(async () => {
    const l = await layout(page);
    return { left: l.left, right: l.right, top: l.bottom!.top - l.title!.bottom };
  }).toEqual({ left: undefined, right: undefined, top: 4 });
  await page.evaluate(() => (window as any).__oxbit.workbench.set({ maxPanel: false }));
  await expect(page.locator(".dock-left")).toBeVisible();

  await page.locator(".dock-bottom").getByRole("button", { name: /^Panel actions/ }).click();
  await page.getByRole("menuitem", { name: "Align Panel: Right" }).click();
  await expect(page.locator(".workbench")).toHaveAttribute("data-panel-alignment", "right");
  await page.screenshot({ path: "evidence/panel-alignment/right.png" });

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.locator(".workbench")).toHaveAttribute("data-panel-alignment", "center");
});
