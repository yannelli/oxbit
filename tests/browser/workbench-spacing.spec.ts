import { test, expect } from "@playwright/test";

test("workspace and pane gutters stay even on both sides", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(() => {
    const wb = (window as any).__oxbit.workbench;
    wb.openPanel("problems");
  });

  for (const width of [1700, 1440, 1100, 1099, 768, 600]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const side of ["left", "right"] as const) {
      await page.evaluate((side) => {
        const wb = (window as any).__oxbit.workbench;
        wb.movePanel("explorer", { container: side });
        const layout = wb.getPanelLayout();
        layout.docks.left.visible = side === "left";
        layout.docks.right.visible = side === "right";
        wb.set({ panelLayout: layout });
      }, side);
      await expect(page.locator(`.dock-${side}`)).toBeVisible();
      await expect.poll(() => page.evaluate((side) => {
        const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const title = bounds(".titlebar"), status = bounds(".statusbar");
        const activity = bounds(".activity-bar"), main = bounds(".main-workbench");
        const dock = bounds(`.dock-${side}`), body = bounds(".workspace-body");
        const desktop = innerWidth >= 1100;
        return {
          top: dock.top - title.bottom,
          bottom: status.top - dock.bottom,
          outer: side === "left" ? dock.left - activity.right : body.right - dock.right,
          editorTop: main.top - title.bottom,
          editorBottom: status.top - main.bottom,
          paneGap: desktop ? (side === "left" ? main.left - dock.right : dock.left - main.right) : 4,
          editorEdge: side === "right" || !desktop ? main.left - activity.right : body.right - main.right,
        };
      }, side)).toEqual({ top: 4, bottom: 4, outer: 4, editorTop: 4, editorBottom: 4, paneGap: 4, editorEdge: 4 });
      if (width === 1700 && side === "right") {
        const editor = await page.locator(".editor-groups").boundingBox();
        const panel = await page.locator(".dock-bottom").boundingBox();
        expect(panel!.y - editor!.y - editor!.height).toBe(4);
        await page.screenshot({ path: "evidence/workbench-spacing/right-explorer.png" });
      }
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const wb = (window as any).__oxbit.workbench;
    const layout = wb.getPanelLayout();
    layout.docks.left.visible = false;
    layout.docks.right.visible = false;
    wb.set({ panelLayout: layout, panel: false });
  });
  const activity = await page.locator(".activity-bar").boundingBox();
  const main = await page.locator(".main-workbench").boundingBox();
  expect(main!.x).toBe(activity!.x + activity!.width + 4);
  expect(main!.x + main!.width).toBe(1436);
});
