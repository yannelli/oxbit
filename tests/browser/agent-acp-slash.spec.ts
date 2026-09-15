import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";

for (const width of [1440, 390]) test.describe(`slash commands at ${width}px`, () => {
  test.use({ viewport: { width, height: 844 }, hasTouch: width === 390 });
  test("typing / offers agent commands and sends the selected command with arguments", async ({ page }) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-slash-")));
    const runtime = await createRuntime({ root, port: 0, dataDir: path.join(root, "state"),
      settingsFile: path.join(root, "settings.json"), projectsDir: path.join(root, "projects"),
      pairingCode: "slash-test" });
    try {
      await page.goto(`http://127.0.0.1:${runtime.port}`);
      await page.waitForFunction(() => (window as any).__oxbit?.ready);
      await page.evaluate(async (url) => {
        await (window as any).__oxbit.connectRuntime(url, "slash-test");
      }, `http://127.0.0.1:${runtime.port}`);
      await page.waitForFunction(() => (window as any).__oxbit.runtime?.connected);
      await page.evaluate(async ({ command, fixture }) => {
        const app = (window as any).__oxbit;
        await app.runtime.trust(true);
        await app.kernel.extensions.activate("oxbit.agent-acp");
        await app.kernel.configuration.set("agentACP.codex.command", command, "user");
        await app.kernel.configuration.set("agentACP.codex.args", JSON.stringify([fixture]), "user");
        app.workbench.set({ sidebarWidth: 420 });
        app.workbench.run("agentACP.open");
      }, { command: process.execPath,
        fixture: path.resolve("tests/fixtures/agent-acp/agent.mjs") });
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      const ready = () => expect(page.locator(".acp-status")).toHaveText("Ready");
      await ready();
      const input = page.getByRole("textbox", { name: "Message agent" });
      const list = page.getByRole("listbox", { name: "Agent slash commands" });
      await input.fill("hello");
      await input.press("Control+Enter");
      await expect(page.getByRole("log")).toContainText("Done.");
      await ready();
      await input.fill("/");
      await expect(list).toBeVisible();
      await expect(list.getByRole("option")).toHaveCount(2);
      await input.press("ArrowDown");
      await expect(list.getByRole("option", { selected: true })).toContainText("/help");
      await input.press("Enter");
      await expect(input).toHaveValue("/help ");
      await expect(input).toBeFocused();
      await expect(list).toBeHidden();
      await expect(page.getByRole("log")).not.toContainText("Command received");
      await input.fill("/re");
      await expect(list.getByRole("option")).toHaveCount(1);
      await input.press("Tab");
      await expect(input).toHaveValue("/review ");
      await input.pressSequentially("src/example.ts");
      await input.press("Control+Enter");
      await expect(page.getByRole("log")).toContainText("Command received: /review src/example.ts");
      await ready();
      await input.fill("/");
      await input.press("Escape");
      await expect(list).toBeHidden();
      await expect(input).toHaveValue("/");
      await input.pressSequentially("h");
      await expect(list).toBeVisible();
      const bounds = await list.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      await page.screenshot({ path: `test-results/acp-slash-${width}.png` });
      const option = list.getByRole("option").first();
      if (width === 390) await option.tap(); else await option.click();
      await expect(input).toHaveValue("/help ");
      await expect(input).toBeFocused();
      for (const text of ["look /review", "path/to/file", "/unknown", "/review args"]) {
        await input.fill(text);
        await expect(list).toBeHidden();
      }
      await input.fill("/custom argument");
      await input.press("Control+Enter");
      await expect(page.getByRole("log")).toContainText("Command received: /custom argument");
      await ready();
    } finally {
      await page.goto("about:blank");
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
