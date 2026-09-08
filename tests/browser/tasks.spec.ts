import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
const ready = async (page: Page) => {
  await page.goto("/#pair=oxbit-tasks-test");
  await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    app.workbench.openPanel("tasks");
    app.workbench.set({ panelHeight: 500 });
    await app.kernel.services.get("tasks").refresh();
  });
  await expect(
    page.locator(".task-list-row").filter({ hasText: "Web service" }),
  ).toBeVisible();
};
const row = (page: Page, name: string) =>
  page
    .locator(".task-list-row")
    .filter({
      has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }),
    });
test("imports, edits, runs and stops a real service with links, replay, and theme layouts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await row(page, "Web service")
    .getByRole("button", { name: "Start Web service" })
    .click();
  await expect(page.locator(".tasks-detail .task-state")).toHaveText("ready");
  await expect(
    page.getByRole("navigation", { name: "Detected task links" }),
  ).toContainText("http://");
  const href = await page
    .locator(".task-links a")
    .filter({ hasText: "127.0.0.1" })
    .first()
    .getAttribute("href");
  expect(await (await fetch(href!)).text()).toBe("Oxbit task service");
  await expect(page.getByLabel("Task output", { exact: true })).toContainText(
    "Listening at",
  );
  await page.screenshot({ path: "evidence/tasks/services-dark.png" });
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.configuration.set(
      "workbench.colorTheme",
      "Paper (light)",
    ),
  );
  await page.screenshot({ path: "evidence/tasks/services-light.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "evidence/tasks/services-phone.png" });
  expect(
    await page
      .locator(".tasks-panel")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator(".tasks-detail")
    .getByRole("button", { name: "Force stop", exact: true })
    .click();
  await expect(page.locator(".tasks-detail .task-state")).toHaveText("stopped");
  await row(page, "Build").getByRole("button").first().click();
  await page
    .locator(".tasks-detail")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit task" });
  await expect(dialog.locator(".task-command")).toBeFocused();
  await dialog.locator(".task-command").fill("printf 'edited build\\n'");
  await dialog.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(dialog).toBeHidden();
  const { root } = JSON.parse(
    await fs.readFile("evidence/tasks/browser-workspace.json", "utf8"),
  );
  const saved = await fs.readFile(
    path.join(root, ".vscode/tasks.json"),
    "utf8",
  );
  expect(saved).toContain("// Retain this comment");
  expect(saved).toContain("Keep this IDE detail");
  expect(saved).toContain("edited build");
  await row(page, "Build").getByRole("button", { name: "Start Build" }).click();
  await expect(page.locator(".tasks-detail .task-state")).toHaveText(
    "completed",
  );
  await expect(page.getByLabel("Task output", { exact: true })).toContainText(
    "edited build",
  );
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected);
  await page.evaluate(() =>
    (window as any).__oxbit.workbench.openPanel("tasks"),
  );
  await expect(
    page.locator(".task-run-row").filter({ hasText: "Build" }),
  ).toBeVisible();
  await page
    .locator(".task-run-row")
    .filter({ hasText: "Build" })
    .first()
    .click();
  await expect(page.getByLabel("Task output", { exact: true })).toContainText(
    "edited build",
  );
  expect(errors).toEqual([]);
});
test("retains an editor draft on revision conflict and supports keyboard cancellation", async ({
  page,
}) => {
  await ready(page);
  await row(page, "Build").getByRole("button").first().click();
  await page
    .locator(".tasks-detail")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit task" });
  await dialog.locator(".task-command").fill("echo draft must remain");
  const { root } = JSON.parse(
    await fs.readFile("evidence/tasks/browser-workspace.json", "utf8"),
  );
  await fs.appendFile(
    path.join(root, ".vscode/tasks.json"),
    "\n// external edit\n",
  );
  await dialog.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("changed");
  await expect(dialog.locator(".task-command")).toHaveValue(
    "echo draft must remain",
  );
  await dialog.locator(".task-command").focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(
    page
      .locator(".tasks-detail")
      .getByRole("button", { name: "Edit", exact: true }),
  ).toBeFocused();
});
test("saves lifecycle scripts and executes them around managed worktree creation/removal", async ({
  page,
}) => {
  await ready(page);
  await page
    .getByRole("button", {
      name: "Worktree lifecycle and environment",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Worktree lifecycle and environment",
  });
  await dialog
    .getByLabel("preinit script", { exact: true })
    .fill('echo preinit > "$OXBIT_PREINIT_DIR/seed"');
  await dialog
    .getByLabel("init script", { exact: true })
    .fill('cp "$OXBIT_PREINIT_DIR/seed" generated');
  await dialog
    .getByLabel("preteardown script", { exact: true })
    .fill("echo before removal");
  await dialog
    .getByLabel("teardown script", { exact: true })
    .fill('test ! -e "$OXBIT_PROJECT_DIR"; echo removed');
  await dialog.getByRole("button", { name: "Save lifecycle" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("tab", { name: "Worktrees", exact: true }).click();
  await page
    .getByRole("button", { name: "Create worktree", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "New worktree branch" })
    .getByRole("textbox")
    .fill("test/tasks-ui");
  await page
    .getByRole("dialog", { name: "New worktree branch" })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Create worktree from revision" })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  const tree = page.locator(".task-worktree");
  await expect(tree).toContainText("test/tasks-ui");
  await expect(tree.locator(".task-state")).toHaveText("ready");
  await page.screenshot({ path: "evidence/tasks/worktrees.png" });
  await tree
    .getByRole("button", { name: "Remove worktree", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "Remove worktree" })
    .getByRole("button", { name: "Remove worktree", exact: true })
    .click();
  await expect(tree).toHaveCount(0);
  await page
    .getByRole("tab", { name: "Tasks & services", exact: true })
    .click();
  await expect(
    page.locator(".task-run-row").filter({ hasText: "teardown" }).first(),
  ).toContainText("completed");
});
