import { test, expect } from "@playwright/test";

test("brand preview switches themes under the runtime content security policy", async ({ page, request }) => {
  await page.goto("/brand/");
  await expect(page).toHaveTitle("Oxbit brand assets");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("#hero-logo")).toHaveAttribute("src", "oxbit-logo-dark.svg");
  await expect(page.locator(".hero")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("#hero-logo")).toHaveAttribute("src", "oxbit-logo.svg");
  const download = await request.get("/brand/oxbit-brand-kit.zip");
  expect(download.ok()).toBe(true);
  expect((await download.body()).subarray(0, 2).toString()).toBe("PK");
});

test("Oxbit branding, assets, and storage work on a fresh browser profile", async ({
  page,
  request,
}) => {
  const failedAssets: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedAssets.push(response.url());
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await expect(page).toHaveTitle("Oxbit — Workbench");
  await expect(page.locator(".brand")).toHaveAccessibleName("Oxbit");
  await expect(page.locator(".brand")).toHaveAttribute("role", "img");
  await expect(page.locator(".brand .oxbit-mark")).toHaveCSS(
    "mask-image",
    /\/brand\/oxbit-mark\.svg/,
  );
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", "/favicon.svg");
  await expect(page.locator('link[rel="icon"][sizes="any"]')).toHaveAttribute("href", "/favicon.ico");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/site.webmanifest");
  for (const [path, contentType] of [
    ["/brand/oxbit-mark.svg", "image/svg+xml"],
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon.ico", "image/"],
    ["/apple-touch-icon.png", "image/png"],
    ["/icon-192.png", "image/png"],
    ["/icon-512.png", "image/png"],
  ]) {
    const response = await request.get(path);
    expect(response.ok(), path).toBe(true);
    expect(response.headers()["content-type"], path).toContain(contentType);
    expect((await response.body()).length, path).toBeGreaterThan(0);
  }
  const manifestResponse = await request.get("/site.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  expect(await manifestResponse.json()).toMatchObject({
    name: "Oxbit",
    icons: expect.arrayContaining([
      expect.objectContaining({ src: "/icon-192.png", sizes: "192x192", type: "image/png" }),
      expect.objectContaining({ src: "/icon-512.png", sizes: "512x512", type: "image/png" }),
    ]),
  });
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name),
    ),
  ).toContain("oxbit");
  await page.evaluate(() => {
    void (window as any).__oxbit.kernel.commands.execute("help.about");
  });
  await expect(page.getByRole("dialog")).toContainText("Oxbit");
  expect(failedAssets).toEqual([]);
});

test("an Oxbit browser workspace and formatter preference persist across reloads", async ({
  page,
}) => {
  // Seed the Oxbit database on the app's origin before loading its scripts.
  await page.route("**/branding-seed", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Storage setup</title>" }),
  );
  await page.goto("/branding-seed");
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("oxbit", 1);
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
          user: { "editor.defaultFormatter": "oxbit.builtin-ts" },
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
  ).toEqual(["oxbit"]);
});
