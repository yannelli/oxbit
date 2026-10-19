import { expect, test, type Page } from "@playwright/test";
import { AGENT_ACTIVITY_SERVICE } from "../../packages/sdk/src/agent-acp.js";
import { installBridge } from "./bridge.js";

const SETTING = "runtime.backgroundLocation";

async function openDocuments(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
}

const calls = (page: Page) => page.evaluate(() => [...(window as any).__iosTest.backgroundLocation]);
const activity = (page: Page, status: string | null) => page.evaluate(({ service, status }) =>
  (window as any).__oxbit.kernel.services.get(service).update(status && { agent: "Oxbit", title: "Turn", status, detail: "", pending: 0 }),
{ service: AGENT_ACTIVITY_SERVICE, status });

test("Stay Connected in the Background runs location only during an agent turn in a device folder", async ({ page }) => {
  await installBridge(page);
  await openDocuments(page);
  expect(await page.evaluate(id => (window as any).__oxbit.kernel.configuration.get(id), SETTING)).toBe(false);
  await activity(page, "working");
  expect(await calls(page)).toEqual([]);

  await page.evaluate(id => (window as any).__oxbit.kernel.configuration.set(id, true, "user"), SETTING);
  await expect.poll(() => calls(page)).toEqual([true]);
  await activity(page, "waiting");
  await activity(page, "finished");
  await expect.poll(() => calls(page)).toEqual([true, false]);
});

test("a denied location permission posts one notice", async ({ page }) => {
  await installBridge(page, { locationDenied: true });
  await openDocuments(page);
  await page.evaluate(id => (window as any).__oxbit.kernel.configuration.set(id, true, "user"), SETTING);
  await activity(page, "working");
  await expect(page.getByText(/Location access is off for Oxbit/)).toHaveCount(1);
  await activity(page, "finished");
  await activity(page, "working");
  expect(await calls(page)).toEqual([true]);
});
