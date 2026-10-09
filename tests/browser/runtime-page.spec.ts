import { expect, test, type Page } from "@playwright/test";

const PAIRING_CODE = "oxbit-acceptance-2026";
const shots = "/tmp/oxbit-p1/";

async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
}
const runtimePage = (page: Page) => page.locator(".runtime-page");

test("the cloud button opens the Runtime page, which pairs and then describes the runtime", async ({ page }) => {
  await ready(page);
  await page.locator(".connection-button").click();
  await expect(runtimePage(page)).toBeVisible();
  await expect(runtimePage(page).getByRole("status").first()).toHaveText("Not connected");
  await expect(runtimePage(page).getByRole("region", { name: "Keep alive" })).toBeVisible();
  await page.screenshot({ path: shots + "web-runtime-unpaired.png" });
  await page.getByRole("textbox", { name: "Runtime URL" }).fill(new URL(page.url()).origin);
  await page.getByRole("textbox", { name: "Pairing code" }).fill(PAIRING_CODE);
  await page.getByRole("button", { name: "Pair and connect" }).click();
  await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected === true);

  await page.locator(".connection-button").click();
  const view = runtimePage(page);
  await expect(view.locator(".runtime-hero")).toHaveAttribute("data-state", "connected");
  await expect(view.locator(".runtime-facts")).toContainText("9278");
  await expect(view.locator(".runtime-facts")).toContainText("Version");
  await expect(view.getByRole("region", { name: "Saved runtimes" })).toContainText("In use");
  await expect(view.getByRole("switch", { name: /Trusted|Restricted/ })).toBeVisible();
  await page.screenshot({ path: shots + "web-runtime-connected.png" });
});

test("one tap reconnects a saved runtime and opens the page with the reason when it fails", async ({ page }) => {
  await ready(page);
  await page.evaluate(code => (window as any).__oxbit.connectRuntime(location.origin, code), PAIRING_CODE);
  await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected === true);
  await page.evaluate(() => (window as any).__oxbit.runtimeConnector.disconnect());
  const cloud = page.locator(".connection-button");
  await expect(cloud).toHaveAttribute("data-state", "disconnected");

  await cloud.click();
  await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected === true);
  await expect(page.locator(".connection-button")).toHaveAttribute("data-state", "connected");
  await expect(runtimePage(page)).toHaveCount(0);

  await page.evaluate(() => (window as any).__oxbit.runtimeConnector.disconnect());
  // New sockets go to a closed port while HTTP still answers, as when a proxy drops WebSocket upgrades.
  await page.evaluate(() => {
    const Native = WebSocket;
    (window as any).__nativeWebSocket = Native;
    window.WebSocket = class extends Native { constructor(url: string | URL) { super(String(url).replace(/:\d+\//, ":9/")); } } as typeof WebSocket;
  });
  await page.locator(".connection-button").click();
  const alert = runtimePage(page).getByRole("alert");
  await expect(alert).toContainText("refused this browser");
  await expect(page.locator(".connection-button")).toHaveAttribute("data-state", "failed");
  await page.screenshot({ path: shots + "web-runtime-failed.png" });

  await page.evaluate(() => { window.WebSocket = (window as any).__nativeWebSocket; });
  await runtimePage(page).getByRole("button", { name: /^Connect to / }).click();
  await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected === true);
});
