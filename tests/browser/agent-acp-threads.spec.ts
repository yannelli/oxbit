import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";

const shots = "/tmp/oxbit-agents/threads";

async function boot(page: Page, pairingCode: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-threads-")));
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "hello.txt"), "hello\n");
  const runtime = await createRuntime({
    root, port: 0, dataDir: path.join(directory, "state"),
    settingsFile: path.join(directory, "settings.json"), projectsDir: path.join(directory, "projects"),
    pairingCode, origins: ["http://127.0.0.1:9278"],
  });
  await page.goto(`http://127.0.0.1:${runtime.port}`);
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async ({ url, code }) => (window as any).__oxbit.connectRuntime(url, code),
    { url: `http://127.0.0.1:${runtime.port}`, code: pairingCode });
  await page.waitForFunction(() => (window as any).__oxbit.runtime?.connected);
  await page.evaluate(async ({ command, fixture }) => {
    const z = (window as any).__oxbit;
    await z.runtime.trust(true);
    await z.kernel.extensions.activate("oxbit.agent-acp");
    await z.kernel.configuration.set("agentACP.codex.command", command, "user");
    await z.kernel.configuration.set("agentACP.codex.args", JSON.stringify([fixture]), "user");
    z.workbench.set({ sidebarWidth: 460 });
    z.workbench.run("agentACP.open");
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }, { command: process.execPath, fixture: path.resolve("tests/fixtures/agent-acp/agent.mjs") });
  return {
    panel: page.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)"),
    close: async () => {
      await page.close({ runBeforeUnload: false });
      await runtime.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
const liveCount = (page: Page) =>
  page.evaluate(async () => (await (window as any).__oxbit.runtime.request("acp.list", {})).sessions.length);

test("a second thread runs beside a busy one and the strip switches between them", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { panel, close } = await boot(page, "acp-threads");
  try {
    const status = panel.locator(".acp-header .acp-status");
    const composer = panel.getByRole("textbox", { name: "Message agent" });
    const send = async (text: string) => {
      await composer.fill(text);
      await panel.getByRole("button", { name: /^(Send|Queue message)$/ }).click();
    };
    await panel.getByRole("button", { name: /^Start / }).click();
    await expect(status).toHaveText("Ready");
    await send("wait");
    await expect(status).toHaveText("Working…");

    await panel.getByRole("button", { name: "More agent actions" }).click();
    await panel.getByRole("menuitem", { name: "New thread" }).click();
    await expect(panel.getByRole("heading", { name: "Choose an agent" })).toBeVisible();
    const strip = panel.getByRole("navigation", { name: "Agent threads" });
    const chips = strip.locator(".acp-thread-select");
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).not.toHaveAttribute("aria-current");
    await panel.getByRole("button", { name: /^Start / }).click();
    await expect(status).toHaveText("Ready");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText("wait");
    await expect(chips.nth(0)).toContainText("Working… · Codex ACP");
    await expect(chips.nth(1)).toHaveAttribute("aria-current", "true");
    expect(await liveCount(page)).toBe(2);

    await send("hello");
    await expect(panel.getByRole("log")).toContainText("Done.");
    await expect(chips.nth(1)).toContainText("hello");
    await expect(chips.nth(1)).toContainText("Ready · Codex ACP");
    await expect(chips.nth(0)).toContainText("Working…");
    await send("permission");
    await expect(panel.getByText("Permission required")).toBeVisible();
    await expect(chips.nth(1)).toContainText("Needs input (1)");

    await chips.nth(0).click();
    await expect(chips.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(chips.nth(1)).not.toHaveAttribute("aria-current");
    await expect(status).toHaveText("Working…");
    await expect(panel.getByRole("log")).toContainText("wait");
    await expect(panel.getByRole("log")).not.toContainText("Done.");
    await expect(chips.nth(1)).toContainText("Needs input (1)");
    await expect(chips.nth(0)).toContainText("Working…");
    for (const dismiss of await page.getByRole("button", { name: "Dismiss notification" }).all()) await dismiss.click();
    await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/desktop-1440x900.png` });

    const views = page.getByRole("navigation", { name: "Primary views" });
    await page.evaluate(() => (window as any).__oxbit.workbench.openPanel("agent-acp-agents"));
    await expect(panel).toBeHidden();
    const agentButton = views.getByRole("button", { name: "Agent ACP, Agent needs input", exact: true });
    await expect(agentButton.locator(".badge.badge-attention")).toHaveText("1");
    await agentButton.click();
    await expect(strip).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (window as any).__oxbit.workbench.run("agentACP.open"));
    await expect(strip).toBeInViewport();
    expect(await strip.evaluate((node) => getComputedStyle(node).overflowX)).toBe("auto");
    for (const control of [...await strip.locator(".acp-thread-select").all(), ...await strip.getByRole("button", { name: /^Stop / }).all()]) {
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: `${shots}/phone-390x844.png` });

    await strip.getByRole("button", { name: "Stop hello", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Stop thread" }).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(strip).toBeHidden();
    expect(await liveCount(page)).toBe(1);
    await expect(status).toHaveText("Working…");
  } finally {
    await close();
  }
});

test("the device limit shows the runtime message and the strip stops a thread", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { panel, close } = await boot(page, "acp-threads-limit");
  try {
    const status = panel.locator(".acp-header .acp-status");
    const strip = panel.getByRole("navigation", { name: "Agent threads" });
    const start = () => panel.getByRole("button", { name: /^Start / }).click();
    const newThread = async () => {
      await panel.getByRole("button", { name: "More agent actions" }).click();
      await panel.getByRole("menuitem", { name: "New thread" }).click();
    };
    for (let index = 0; index < 3; index++) {
      if (index) await newThread();
      await start();
      await expect(status).toHaveText("Ready");
      await panel.getByRole("textbox", { name: "Message agent" }).fill("wait");
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await expect(status).toHaveText("Working…");
    }
    await newThread();
    await start();
    await expect(panel.getByRole("alert")).toHaveText("3 agents are running for this device; stop one in Runtime sessions");
    await expect(status).toHaveText("Agent limit reached");
    await expect(strip.locator(".acp-thread-select")).toHaveCount(3);
    await strip.getByRole("button", { name: "Stop wait", exact: true }).first().click();
    await page.getByRole("alertdialog", { name: "Stop thread" }).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(strip.locator(".acp-thread-select")).toHaveCount(2);
    await expect(panel.getByRole("alert")).toBeHidden();
    await start();
    await expect(status).toHaveText("Ready");
    await expect(strip.locator(".acp-thread-select")).toHaveCount(3);
    expect(await liveCount(page)).toBe(3);
  } finally {
    await close();
  }
});
