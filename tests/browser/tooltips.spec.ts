import { test, expect, type Page } from "@playwright/test";

async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await expect(page.locator(".cm-editor").first()).toBeVisible();
}

test("icon tooltips cover toolbars, activity views, and tab actions", async ({
  page,
}) => {
  await ready(page);
  for (const label of [
    "Toggle theme",
    "Toggle left panels",
    "Explorer",
    "Settings",
    "New File",
    "Close useTelemetry.ts",
  ]) {
    const button = label.startsWith("Close ")
      ? page
          .locator(".tabbar")
          .getByRole("button", { name: label, exact: true })
      : page.getByRole("button", { name: label, exact: true });
    await button.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText(label);
    await expect(tooltip).toBeVisible();
    await expect(button).toHaveAttribute(
      "aria-describedby",
      (await tooltip.getAttribute("id"))!,
    );
    await page.mouse.move(900, 350);
    await expect(tooltip).toHaveCount(0);
    await expect(button).not.toHaveAttribute("aria-describedby");
  }
});

test("keyboard focus reveals help and Escape dismisses only the tooltip", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Focus mode", exact: true }).focus();
  await page.keyboard.press("Tab");
  const button = page.getByRole("button", {
    name: "Toggle theme",
    exact: true,
  });
  await expect(button).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText("Toggle theme");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("tooltip")).toHaveText("Toggle theme");
});

test("tooltips stay hoverable and recover after a dismissed or interrupted hover", async ({
  page,
}) => {
  await ready(page);
  const button = page.getByRole("button", {
    name: "Toggle theme",
    exact: true,
  });
  const tooltip = page.getByRole("tooltip");
  await button.hover();
  await expect(tooltip).toBeVisible();
  await tooltip.hover();
  await page.waitForTimeout(250);
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(900, 350);
  await button.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(900, 350);
  await expect(tooltip).toHaveCount(0);
  await button.hover();
  await page.waitForTimeout(50);
  await page.mouse.move(900, 350);
  await page.waitForTimeout(50);
  await button.hover();
  await expect(tooltip).toBeVisible();
});

test("clicks, scrolling, and disappearing controls clear tooltips", async ({
  page,
}) => {
  await ready(page);
  const tooltip = page.getByRole("tooltip");
  const toggle = page.getByRole("button", {
    name: "Toggle theme",
    exact: true,
  });
  await toggle.hover();
  await expect(tooltip).toBeVisible();
  await toggle.click();
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(900, 350);
  await toggle.hover();
  await expect(tooltip).toBeVisible();
  await page
    .locator(".cm-scroller")
    .first()
    .evaluate((element) => {
      element.scrollTop = 300;
    });
  await expect(tooltip).toHaveCount(0);
  const close = page
    .locator(".tabbar")
    .getByRole("button", { name: "Close useTelemetry.ts", exact: true });
  await close.hover();
  await expect(tooltip).toHaveText("Close useTelemetry.ts");
  await page.evaluate(() =>
    (window as any).__oxbit.workbench.run("editor.closeTab"),
  );
  await expect(tooltip).toHaveCount(0);
});

test("tooltip colors follow all themes and stay inside desktop and phone edges", async ({
  page,
}, testInfo) => {
  await ready(page);
  for (const name of [
    "Graphite (dark)",
    "Paper (light)",
    "Load Bearing (dark)",
    "Load Bearing (light)",
  ]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(
      (name) =>
        (window as any).__oxbit.kernel.configuration.set(
          "workbench.colorTheme",
          name,
        ),
      name,
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.mouse.move(width / 2, 350);
      await page
        .getByRole("button", {
          name: width === 1440 ? "Toggle theme" : "Settings",
          exact: true,
        })
        .hover();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toBeVisible();
      const rect = (await tooltip.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.height).toBeLessThanOrEqual(900);
      expect(
        await tooltip.evaluate((element) => {
          const style = getComputedStyle(element);
          const sample = document.createElement("span");
          sample.style.backgroundColor = "var(--bg-raised)";
          element.append(sample);
          const matches =
            getComputedStyle(sample).backgroundColor === style.backgroundColor;
          sample.remove();
          return matches;
        }),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(
          `${name.replaceAll(/[^a-z]/gi, "-")}-${width}.png`,
        ),
      });
    }
  }
});

test("touch taps do not leave a hover tooltip open", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await ready(page);
    await page.getByRole("button", { name: "Settings", exact: true }).tap();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(450);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("dialog icons have one tooltip and dismiss it before closing the dialog", async ({
  page,
}) => {
  await ready(page);
  await page.locator(".connection-button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .hover();
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await expect(page.getByRole("tooltip")).toHaveText("Close dialog");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
