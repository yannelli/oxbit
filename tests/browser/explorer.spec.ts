import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("explorer loads expanded folders, reveals search results, and exports collapsed folders", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__zapp?.ready === true);
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
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
      page.evaluate(() => (window as any).__zapp.workbench.activePath()),
    )
    .toBe("lazy-fixture/child/visible.txt");
  await folder.click();
  await expect(child).not.toBeVisible();
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
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
    (window as any).__zapp.kernel.commands.execute("workspace.export"),
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
    (window as any).__zapp.kernel.commands.execute("workbench.quickOpen"),
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
    (window as any).__zapp.kernel.commands.execute("file.move", {
      from: "lazy-fixture/unopened",
      to: "lazy-fixture/renamed",
      confirmed: true,
    }),
  );
  await expect(
    page.locator('[role="treeitem"][title="lazy-fixture/renamed/needle.txt"]'),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as any).__zapp.workbench.activePath(),
  )).toBe("lazy-fixture/renamed/needle.txt");
  await folder.click();
  await page.evaluate(() => (window as any).__zapp.workbench.persist());
  await page.reload();
  await page.waitForFunction(() => (window as any).__zapp?.ready === true);
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() =>
    (window as any).__zapp.workbench.state.files.some((file: { path: string }) =>
      file.path.startsWith("lazy-fixture/"),
    ),
  )).toBe(false);
});
