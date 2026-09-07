import { test, expect } from "@playwright/test";

test("Oxbit branding, assets, and storage work on a fresh browser profile", async ({
  page,
}) => {
  const failedAssets: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedAssets.push(response.url());
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await expect(page).toHaveTitle("Oxbit — Workbench");
  await expect(page.locator(".brand")).toHaveText("O");
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name),
    ),
  ).toContain("oxbit");
  await page.evaluate(() => {
    void (window as any).__oxbit.kernel.commands.execute("help.about");
  });
  await expect(page.getByRole("dialog")).toContainText("Oxbit");
  await expect(page.getByRole("dialog")).not.toContainText("Zapp");
  expect(failedAssets).toEqual([]);
});

test("an existing browser workspace and formatter preference survive the rebrand", async ({
  page,
}) => {
  // Seed the original database on the app's origin before loading its scripts.
  await page.route("**/branding-seed", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Storage setup</title>" }),
  );
  await page.goto("/branding-seed");
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("zapp", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("data");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("data", "readwrite");
      const store = transaction.objectStore("data");
      store.put(
        {
          version: 1,
          directories: [],
          files: {
            "keep.txt": {
              text: "My existing workspace",
              revision: "original",
              encoding: "utf-8",
              eol: "LF",
            },
          },
        },
        "filesystem:browser",
      );
      store.put(
        {
          user: { "editor.defaultFormatter": "zapp.builtin-ts" },
          workspace: {},
          userLanguages: {},
          workspaceLanguages: {},
        },
        "settings",
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  expect(
    await page.evaluate(async () => {
      const app = (window as any).__oxbit;
      return {
        text: (await app.filesystem.read("keep.txt")).text,
        formatter: app.kernel.configuration.get("editor.defaultFormatter"),
      };
    }),
  ).toEqual({ text: "My existing workspace", formatter: "oxbit.builtin-ts" });
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  expect(
    await page.evaluate(
      async () =>
        (await (window as any).__oxbit.filesystem.read("keep.txt")).text,
    ),
  ).toBe("My existing workspace");
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name),
    ),
  ).toEqual(["zapp"]);
});
