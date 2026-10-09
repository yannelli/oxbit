import { expect, test, type Page } from "@playwright/test";
import { installBridge, type BridgeRuntime } from "./bridge.js";

const studio: BridgeRuntime = { runtimeId: "abc12345-0000-4000-8000-000000000001", name: "studio", version: "0.4.1", host: "127.0.0.1", port: 1, url: "http://127.0.0.1:1" };
const laptop: BridgeRuntime = { runtimeId: "abc12345-0000-4000-8000-000000000002", name: "laptop", host: "127.0.0.1", port: 2, url: "http://127.0.0.1:2" };
const shots = "/tmp/oxbit-p1/";
const requests = (page: Page) => page.evaluate(() => (window as any).__iosTest.runtimeRequests);

test("Connect Runtime opens the Runtime page with network runtimes and pairs one", async ({ page }) => {
  await installBridge(page, {
    runtimes: [studio, laptop],
    stored: { "session:recents": [{ id: "runtime:laptop", kind: "runtime", name: "laptop", url: laptop.url, runtimeId: laptop.runtimeId, lastOpened: 1 }] },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Runtime…" }).click();
  const sheet = page.locator(".ios-runtime-sheet");
  const network = sheet.getByRole("region", { name: "On this network" });
  await expect(network).toContainText("studio");
  await expect(network.getByRole("button", { name: "Connect", exact: true })).toHaveCount(1);
  await expect(sheet.getByRole("region", { name: "Saved runtimes" })).toContainText("laptop");
  await expect(sheet.locator(".runtime-command")).toHaveText("oxbit --lan");
  await page.screenshot({ path: shots + "ios-harness-runtime-sheet.png", fullPage: true });

  await network.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(sheet.getByRole("textbox", { name: "Runtime URL" })).toHaveValue(studio.url);
  await expect(sheet.getByRole("textbox", { name: "Pairing code" })).toBeFocused();
  await sheet.getByRole("textbox", { name: "Pairing code" }).fill("owner-code");
  await sheet.getByRole("button", { name: "Pair and connect" }).click();
  const alert = sheet.getByRole("alert");
  await expect(alert).toContainText("No runtime answered at http://127.0.0.1:1", { timeout: 20000 });
  expect(await requests(page)).toContainEqual({ operation: "pair", url: studio.url, code: "owner-code" });
  await page.screenshot({ path: shots + "ios-harness-runtime-failed.png", fullPage: true });

  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);
});

test("the Runtime page explains how to allow Local Network access when iOS denies it", async ({ page }) => {
  await installBridge(page, { localNetworkDenied: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Runtime…" }).click();
  const network = page.locator(".ios-runtime-sheet").getByRole("region", { name: "On this network" });
  await expect(network.getByRole("status")).toContainText("Turn on Local Network for Oxbit in Settings");
  await expect(network).not.toContainText("Looking for runtimes");
  await page.screenshot({ path: "/tmp/oxbit-lan/ios-harness-local-network-denied.png", fullPage: true });
});

test("keep-alive chosen on the start screen reaches the workspace settings", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Runtime…" }).click();
  const sheet = page.locator(".ios-runtime-sheet");
  await sheet.getByRole("combobox", { name: "Keep Runtime Alive" }).click();
  await page.getByRole("option", { name: "8 hours" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__iosTest.storage.get("session:runtime-settings"))).toMatchObject({ "runtime.keepAlive": "8h" });
  await sheet.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.locator(".cm-content")).toContainText("/device/Documents");
  // Opening a workspace pushes the stored choice into its settings; a lost value would mirror back as 75s.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__iosTest.storage.get("session:runtime-settings"))).toMatchObject({ "runtime.keepAlive": "8h" });
});

test("one tap inside a workspace connects the saved runtime and opens the page with the reason", async ({ page }) => {
  await installBridge(page, {
    stored: { "session:recents": [{ id: "runtime:laptop", kind: "runtime", name: "laptop", url: laptop.url, runtimeId: laptop.runtimeId, lastOpened: 1 }] },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.locator(".cm-content")).toContainText("/device/Documents");
  await page.getByRole("button", { name: "Runtime connection", exact: true }).first().click();
  const view = page.locator(".runtime-page");
  await expect(view.getByRole("alert")).toContainText("No runtime answered at http://127.0.0.1:2", { timeout: 20000 });
  expect(await requests(page)).toContainEqual({ operation: "get", url: laptop.url, runtimeId: laptop.runtimeId });
  await expect(view.getByRole("button", { name: "Connect to laptop" })).toBeVisible();
  await page.screenshot({ path: shots + "ios-harness-one-tap-failed.png", fullPage: true });
});
