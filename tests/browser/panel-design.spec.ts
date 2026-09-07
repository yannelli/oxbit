import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ready = async (page: Page, connected = false) => {
  page.setDefaultTimeout(15000);
  await page.goto(connected ? "/#pair=oxbit-acceptance-2026" : "/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  if (connected)
    await page.evaluate(() => (window as any).__oxbit.runtime.trust(true));
};
const surface = (page: Page, id: string) =>
  page.evaluate((id) => {
    (window as any).__oxbit.workbench.openPanel(id);
  }, id);

test("custom selects, styled checkboxes, presence spacing and fold alignment", async ({
  page,
}) => {
  await ready(page);
  await surface(page, "output");
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.contributions.register({
      id: "Design diagnostics",
      kind: "outputChannel",
      title: "Design diagnostics",
      data: { lines: ["Design channel ready"] },
    }),
  );
  const channel = page.getByRole("combobox", { name: "Output channel" });
  await channel.click();
  await expect(
    page.getByRole("listbox", { name: "Output channel" }),
  ).toBeVisible();
  await channel.press("End");
  await channel.press("Enter");
  await expect(channel).toHaveText("Design diagnostics");
  await expect(page.locator(".output-panel")).toContainText(
    "Design channel ready",
  );
  await channel.click();
  await channel.press("Home");
  await channel.press("Escape");
  await expect(channel).toBeFocused();
  await expect(channel).toHaveText("Design diagnostics");
  await channel.click();
  await page.locator(".breadcrumbs").click();
  await expect(channel).toHaveAttribute("aria-expanded", "false");
  await channel.focus();
  await channel.press("ArrowDown");
  await channel.press("t");
  await channel.press("Enter");
  await expect(channel).toHaveText("Tasks");
  await channel.click();
  await channel.press("Tab");
  await expect(channel).toHaveAttribute("aria-expanded", "false");

  await surface(page, "collaboration");
  const heading = await page.locator(".presence-heading").boundingBox();
  const rename = await page
    .getByRole("button", { name: "Change name" })
    .boundingBox();
  expect(rename!.y).toBeGreaterThan(heading!.y + heading!.height);
  await expect(page.locator(".presence-description")).toContainText(
    "Connect to a shared workspace",
  );
  await page.screenshot({ path: "evidence/panel-design/presence-dark.png" });

  await page.evaluate(() =>
    (window as any).__oxbit.kernel.commands.execute("settings.open"),
  );
  const modified = page.getByRole("checkbox", {
    name: "Modified",
    exact: true,
  });
  expect(await modified.evaluate((el) => getComputedStyle(el).appearance)).toBe(
    "none",
  );
  await modified.focus();
  await modified.press("Space");
  await expect(modified).toBeChecked();
  await modified.press("Space");
  await expect(modified).not.toBeChecked();
  const language = page.getByRole("combobox", { name: "Language override" });
  await language.click();
  await language.press("t");
  await language.press("Enter");
  await expect(language).toHaveText("typescript");
  await page.screenshot({ path: "evidence/panel-design/settings-dark.png" });
  for (const theme of ["Graphite (dark)", "Paper (light)"]) {
    await page.evaluate(
      (theme) =>
        (window as any).__oxbit.kernel.configuration.set(
          "workbench.colorTheme",
          theme,
        ),
      theme,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (window as any).__oxbit.workbench.set({ sidebar: false, panel: false }));
    await language.click();
    const popup = await page
      .getByRole("listbox", { name: "Language override" })
      .boundingBox();
    expect(popup!.x).toBeGreaterThanOrEqual(0);
    expect(popup!.x + popup!.width).toBeLessThanOrEqual(390);
    expect(popup!.y + popup!.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: `evidence/panel-design/settings-phone-${theme.startsWith("Paper") ? "light" : "dark"}.png`,
    });
    await language.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.workbench.openFile("README.md");
  });
  const marker = page.locator(".cm-fold-marker:visible").first();
  await expect(marker).toBeVisible();
  const before = await page.locator(".cm-content").innerText();
  const alignment = await marker.evaluate((el) => {
    const marker = el.getBoundingClientRect();
    const gutter = el.parentElement!.getBoundingClientRect();
    return Math.abs(
      marker.y + marker.height / 2 - (gutter.y + gutter.height / 2),
    );
  });
  expect(alignment).toBeLessThanOrEqual(2);
  await marker.click();
  await expect(page.locator(".cm-foldPlaceholder")).toBeVisible();
  await page.locator(".cm-fold-marker[data-folded=true]:visible").first().click();
  await expect(page.locator(".cm-content")).toHaveText(before, { useInnerText: true });
});

test("source control keeps its form visible and supports real branches, trees, and staging", async ({
  page,
}) => {
  const { root } = JSON.parse(
    await readFile("evidence/e2e-workspace.json", "utf8"),
  );
  const fixture = "panel-design-fixture/deeply/nested";
  await mkdir(path.join(root, fixture), { recursive: true });
  for (let index = 0; index < 80; index++)
    await writeFile(
      path.join(root, fixture, `long-descriptive-component-name-${index}.tsx`),
      `export const value = ${index};\n`,
    );
  execFileSync("git", ["branch", "design-panel-branch"], { cwd: root });
  await ready(page, true);
  await surface(page, "scm");
  await page.evaluate(() =>
    (window as any).__oxbit.workbench.set({ sidebarWidth: 280 }),
  );
  const branch = page.getByRole("combobox", { name: "Git branch" });
  await expect(branch).toHaveText("main");
  await branch.click();
  await expect(
    page.getByRole("option", { name: "design-panel-branch", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: "design-panel-branch", exact: true })
    .click();
  await expect(branch).toHaveText("design-panel-branch");
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  ).toBe("design-panel-branch");
  await branch.click();
  await page.getByRole("option", { name: "main", exact: true }).click();
  await expect(branch).toHaveText("main");
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.commands.execute("git.checkout"),
  );
  await expect(branch).toHaveAttribute("aria-expanded", "true");
  await branch.press("Escape");
  const message = page.getByRole("textbox", { name: "Commit message" });
  expect((await message.boundingBox())!.height).toBeGreaterThanOrEqual(64);
  await message.fill("Review panel layout");
  const file = `${fixture}/long-descriptive-component-name-0.tsx`;
  await page
    .getByRole("button", { name: "Stage " + file, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unstage " + file, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Commit staged changes", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Unstage " + file, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Commit staged changes", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Unstage " + file, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Switch to tree view" }).click();
  const folder = page.locator('.scm-folder[title="panel-design-fixture/"]');
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await folder.click();
  await expect(
    page.getByRole("button", { name: file, exact: true }),
  ).not.toBeVisible();
  await folder.click();
  await expect(
    page.getByRole("button", { name: file, exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "evidence/panel-design/scm-tree-dark.png" });
  await page.getByRole("button", { name: "Switch to list view" }).click();
  await page.locator(".scm-changes").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(message).toBeVisible();
  expect((await message.boundingBox())!.height).toBeGreaterThanOrEqual(64);
  expect(
    await page
      .locator(".scm-panel")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  expect(
    await page
      .locator(".scm-filename")
      .first()
      .evaluate((el) => getComputedStyle(el).whiteSpace),
  ).toBe("nowrap");
  for (const theme of ["Graphite (dark)", "Paper (light)"]) {
    await page.evaluate(
      (theme) =>
        (window as any).__oxbit.kernel.configuration.set(
          "workbench.colorTheme",
          theme,
        ),
      theme,
    );
    await page.locator(".scm-changes").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: `evidence/panel-design/scm-list-${theme.startsWith("Paper") ? "light" : "dark"}.png`,
    });
  }
});

test("terminal tabs switch, rename, search and split the selected session", async ({
  page,
}) => {
  await ready(page, true);
  await surface(page, "terminal");
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "Terminal sessions" });
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await tabs.getByRole("tab").last().press("Home");
  await expect(tabs.getByRole("tab").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page
    .getByRole("button", { name: "Split terminal", exact: true })
    .click();
  await expect(page.locator(".terminal-session")).toHaveCount(2);
  await expect(page.locator(".terminal-pane-name").first()).toHaveText(
    await tabs.getByRole("tab").first().innerText(),
  );
  await page.screenshot({
    path: "evidence/panel-design/terminal-split-dark.png",
  });
  await page.getByRole("button", { name: "Show single terminal" }).click();
  await expect(page.locator(".terminal-session")).toHaveCount(1);
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Build logs");
  await page.getByRole("dialog").getByRole("textbox").press("Enter");
  await expect(tabs.getByRole("tab", { name: "Build logs" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page
    .getByRole("button", { name: "Search terminal", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Search terminal" }),
  ).toBeFocused();
  await page.getByRole("textbox", { name: "Search terminal" }).press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Search terminal" }),
  ).not.toBeVisible();
  await page.evaluate(() => (window as any).__oxbit.kernel.commands.execute("terminal.search"));
  await expect(page.getByRole("textbox", { name: "Search terminal" })).toBeFocused();
  await page.getByRole("textbox", { name: "Search terminal" }).press("Escape");
  await page.screenshot({ path: "evidence/panel-design/terminal-dark.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page
      .locator(".terminal-panel")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: "evidence/panel-design/terminal-phone-dark.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Terminate", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Terminate", exact: true })
    .click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
});

test("tooltip delay is configurable and explorer rows use a pointer", async ({
  page,
}) => {
  await ready(page);
  expect(
    await page.evaluate(() =>
      (window as any).__oxbit.kernel.configuration.get(
        "workbench.tooltipDelay",
      ),
    ),
  ).toBe(400);
  const row = page.locator('[role="treeitem"]').first();
  await row.hover();
  expect(await row.evaluate((el) => getComputedStyle(el).cursor)).toBe(
    "pointer",
  );
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.configuration.set(
      "workbench.tooltipDelay",
      1200,
    ),
  );
  const button = page.getByRole("button", {
    name: "Toggle theme",
    exact: true,
  });
  await button.hover();
  await page.waitForTimeout(250);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.getByRole("tooltip")).toHaveText("Toggle theme");
  await page.mouse.move(900, 350);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.configuration.set(
      "workbench.tooltipDelay",
      0,
    ),
  );
  await button.hover();
  await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 500 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.commands.execute("settings.open"),
  );
  await page
    .getByRole("textbox", { name: "Search settings" })
    .fill("Tooltip Delay");
  await expect(
    page.getByRole("spinbutton", { name: "Tooltip Delay" }),
  ).toHaveValue("0");
  await page.getByRole("spinbutton", { name: "Tooltip Delay" }).fill("650");
  expect(
    await page.evaluate(() =>
      (window as any).__oxbit.kernel.configuration.get(
        "workbench.tooltipDelay",
      ),
    ),
  ).toBe(650);
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  expect(
    await page.evaluate(() =>
      (window as any).__oxbit.kernel.configuration.get(
        "workbench.tooltipDelay",
      ),
    ),
  ).toBe(650);
});
