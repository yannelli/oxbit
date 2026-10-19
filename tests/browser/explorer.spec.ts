import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("explorer loads expanded folders, reveals search results, and exports collapsed folders", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.filesystem.mkdir("lazy-fixture/child");
    await z.filesystem.mkdir("lazy-fixture/unopened");
    await z.filesystem.write("lazy-fixture/child/visible.txt", "opened", {
      expectedRevision: null,
    });
    await z.filesystem.write("lazy-fixture/unopened/needle.txt", "exported", {
      expectedRevision: null,
    });
    z.workbench.set({ expanded: [], sidebar: true, sidebarId: "explorer" });
    const list = z.filesystem.list.bind(z.filesystem);
    (window as any).__explorerLists = [];
    z.filesystem.list = (path = "") => {
      (window as any).__explorerLists.push(path);
      return list(path);
    };
    await z.workbench.refreshFiles();
  });
  const lists = () =>
    page.evaluate(() => (window as any).__explorerLists as string[]);
  const folder = page.locator('[role="treeitem"][title="lazy-fixture"]');
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  expect(await lists()).toEqual([""]);
  await folder.click();
  const child = page.locator('[role="treeitem"][title="lazy-fixture/child"]');
  await expect(child).toBeVisible();
  expect(await lists()).toEqual(["", "lazy-fixture"]);
  await child.focus();
  await page.keyboard.press("ArrowRight");
  const file = page.locator(
    '[role="treeitem"][title="lazy-fixture/child/visible.txt"]',
  );
  await expect(file).toBeVisible();
  expect(await lists()).toEqual(["", "lazy-fixture", "lazy-fixture/child"]);
  await file.click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__oxbit.workbench.activePath()),
    )
    .toBe("lazy-fixture/child/visible.txt");
  await folder.click();
  await expect(child).not.toBeVisible();
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.workbench.refreshFiles(false);
    (window as any).__explorerLists = [];
    await z.filesystem.write("lazy-fixture/unopened/new.txt", "hidden", {
      expectedRevision: null,
    });
  });
  await page.waitForTimeout(200);
  expect(await lists()).toEqual([]);

  const download = page.waitForEvent("download");
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.commands.execute("workspace.export"),
  );
  const archive = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(archive.files).toContainEqual(
    expect.objectContaining({
      path: "lazy-fixture/unopened/needle.txt",
      text: "exported",
    }),
  );

  await page.evaluate(() =>
    (window as any).__oxbit.kernel.commands.execute("workbench.quickOpen"),
  );
  await page.getByRole("combobox").fill("needle.txt");
  const result = page
    .getByRole("option")
    .filter({ hasText: "lazy-fixture/unopened/needle.txt" });
  await expect(result).toBeVisible();
  await result.click();
  await expect(
    page.locator('[role="treeitem"][title="lazy-fixture/unopened/needle.txt"]'),
  ).toBeVisible();
  await expect(
    page.locator('[role="treeitem"][title="lazy-fixture/unopened"]'),
  ).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.commands.execute("file.move", {
      from: "lazy-fixture/unopened",
      to: "lazy-fixture/renamed",
      confirmed: true,
    }),
  );
  await expect(
    page.locator('[role="treeitem"][title="lazy-fixture/renamed/needle.txt"]'),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as any).__oxbit.workbench.activePath(),
  )).toBe("lazy-fixture/renamed/needle.txt");
  await folder.click();
  await page.evaluate(() => (window as any).__oxbit.workbench.persist());
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() =>
    (window as any).__oxbit.workbench.state.files.some((file: { path: string }) =>
      file.path.startsWith("lazy-fixture/"),
    ),
  )).toBe(false);
});

test("explorer root label stays on one row for long workspace names", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  const name = "SSH · ubuntu@devbox/~/workspace/light-app/with/a/very/long/path";
  await page.evaluate((projectName) => (window as any).__oxbit.workbench.set({ projectName, sidebar: true, sidebarId: "explorer" }), name);
  await page.locator(".sidebar").evaluate((sidebar) => { (sidebar as HTMLElement).style.width = "240px"; });
  const root = page.locator(".section-label", { hasText: name });
  await expect(root).toHaveAttribute("title", name);
  const label = root.locator(".truncate");
  const box = await label.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth, height: element.getBoundingClientRect().height, row: element.parentElement!.getBoundingClientRect().height }));
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(box.height).toBeLessThanOrEqual(box.row);
});

test("Copy Path copies the absolute path and Copy Relative Path the workspace path", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(() => (window as any).__oxbit.workbench.set({ sidebar: true, sidebarId: "explorer", workspaceRoot: "/Users/dev/orbit-dash/" }));
  const row = page.locator('[role="treeitem"][title="src"]');
  const copy = async (item: string) => {
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
    return page.evaluate(() => navigator.clipboard.readText());
  };
  expect(await copy("Copy Path")).toBe("/Users/dev/orbit-dash/src");
  await expect(page.locator(".notification").last()).toContainText("Copied /Users/dev/orbit-dash/src");
  expect(await copy("Copy Relative Path")).toBe("src");
});
