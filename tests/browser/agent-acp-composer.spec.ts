import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";

const fixture = path.resolve("tests/fixtures/agent-acp/agent.mjs");
const shots = "/tmp/oxbit-agents/composer";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function open(page: Page, args: string[] = []) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-composer-")));
  const root = path.join(directory, "workspace");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "hello.txt"), "hello from disk\n");
  await fs.writeFile(path.join(root, "src", "main.ts"), "export const main = 1;\n");
  const runtime = await createRuntime({
    root, port: 0, dataDir: path.join(directory, "state"),
    settingsFile: path.join(directory, "settings.json"),
    projectsDir: path.join(directory, "projects"), pairingCode: "acp-composer",
  });
  await page.goto(`http://127.0.0.1:${runtime.port}`);
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async (url) => {
    await (window as any).__oxbit.connectRuntime(url, "acp-composer");
  }, `http://127.0.0.1:${runtime.port}`);
  await page.waitForFunction(() => (window as any).__oxbit.runtime?.connected);
  await page.evaluate(async ({ command, args }) => {
    const z = (window as any).__oxbit;
    await z.runtime.trust(true);
    await z.kernel.extensions.activate("oxbit.agent-acp");
    z.kernel.services.get("agentACP").selection = { provider: "codex", command, args };
    z.workbench.set({ sidebarWidth: 420 });
    z.workbench.openFile("hello.txt", { preview: false });
    z.workbench.run("agentACP.open");
  }, { command: process.execPath, args: [fixture, ...args] });
  const panel = page.locator(".acp-panel").first();
  return {
    panel,
    input: panel.getByRole("textbox", { name: "Message agent" }),
    log: panel.getByRole("log"),
    ready: () => expect(panel.locator(".acp-status")).toHaveText("Ready"),
    async close() {
      await page.goto("about:blank");
      await runtime.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

const paste = (page: Page, base64: string, type = "image/png") =>
  page.getByRole("textbox", { name: "Message agent" }).evaluate((input, { base64, type }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "shot.png", { type }));
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, { base64, type });

test("composer sends before connect, sends on Enter, mentions files, pastes images and shows tool activity", async ({ page }) => {
  const app = await open(page);
  const { panel, input, log, ready } = app;
  try {
    await fs.mkdir(shots, { recursive: true });
    await expect(input).toHaveAttribute("enterkeyhint", "send");
    await expect(panel.locator(".acp-hint")).toHaveText("Enter to send · Shift+Enter for new line");
    await input.fill("first message");
    await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await input.press("Enter");
    await expect(log).toContainText("first message");
    await expect(log).toContainText("Done.");
    await ready();
    await expect(input).toHaveValue("");

    await input.pressSequentially("line one");
    await input.press("Shift+Enter");
    await input.pressSequentially("line two");
    await expect(input).toHaveValue("line one\nline two");
    await input.press("Enter");
    await expect(log.locator(".acp-user-text").last()).toHaveText("line one\nline two");
    await ready();

    await page.evaluate(() => (window as any).__oxbit.kernel.configuration.set("agentACP.useModifierToSend", true, "user"));
    await expect(panel.locator(".acp-hint")).toHaveText("Ctrl/Cmd+Enter to send");
    await input.fill("modifier only");
    await input.press("Enter");
    await expect(input).toHaveValue("modifier only\n");
    await input.press("Control+Enter");
    await expect(log.locator(".acp-user-text").last()).toHaveText("modifier only");
    await ready();
    await page.evaluate(() => (window as any).__oxbit.kernel.configuration.set("agentACP.useModifierToSend", false, "user"));

    const slash = panel.getByRole("button", { name: "Slash commands", exact: true });
    await input.fill("");
    await slash.click();
    await expect(input).toHaveValue("/");
    await expect(input).toBeFocused();
    const commands = page.getByRole("listbox", { name: "Agent slash commands" });
    await expect(commands.getByRole("option")).toHaveCount(2);
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(input).toHaveValue("/help ");
    await expect(panel.getByRole("combobox", { name: "Agent slash commands" })).toHaveCount(0);

    await input.fill("Explain @mai");
    const mentions = page.getByRole("listbox", { name: "Mention files and context" });
    await expect(mentions.getByRole("option", { name: /main\.ts/ })).toBeVisible();
    await expect(mentions.getByRole("option", { name: /Selection/ })).toHaveCount(0);
    await input.press("Enter");
    await expect(input).toHaveValue("Explain @src/main.ts ");
    await expect(panel.getByRole("button", { name: "Remove attachment src/main.ts" })).toBeVisible();
    await input.pressSequentially("@");
    await expect(mentions.getByRole("option", { name: /Selection/ })).toBeVisible();
    await expect(mentions.getByRole("option", { name: /Diagnostics/ })).toBeVisible();
    await input.press("Escape");
    await expect(mentions).toBeHidden();

    await input.fill("Look at this");
    await paste(page, PNG);
    const chip = panel.locator(".acp-attachments .acp-image-item img");
    await expect(chip).toBeVisible();
    await page.screenshot({ path: `${shots}/desktop-composer.png` });
    await input.press("Enter");
    await expect(log).toContainText("Received image image/png");
    await expect(log.locator(".acp-image-item")).toContainText("shot.png");
    await expect(log.locator(".acp-image-item img")).toHaveCount(0);
    await ready();
    const saved = await page.evaluate(async () => {
      const agent = (window as any).__oxbit.kernel.services.get("agentACP");
      await agent.saveConversation();
      return JSON.stringify(agent.history.entries);
    });
    expect(saved).toContain("shot.png");
    expect(saved).not.toContain(PNG.slice(0, 24));

    await input.fill("tool-kinds");
    await input.press("Enter");
    await ready();
    for (const kind of ["Read", "Edit", "Delete", "Move", "Search", "Execute", "Think", "Fetch", "Switch mode", "Other"])
      await expect(log.getByRole("img", { name: kind, exact: true })).toBeVisible();
    await expect(log.locator(".acp-tool[data-kind=read]").getByRole("img", { name: "Completed" })).toBeVisible();
    await expect(log.locator(".acp-tool[data-kind=edit]").getByRole("img", { name: "Failed" })).toBeVisible();
    await expect(log.locator(".acp-tool[data-kind=delete] .acp-spinner")).toBeVisible();
    await expect(log.locator(".acp-tool[data-kind=move] .acp-spinner")).toBeVisible();
    await log.getByText("Tool execute").click();

    await input.fill("wait");
    await input.press("Enter");
    const working = panel.locator(".acp-working");
    await expect(working).toHaveText(/^Working · [0-9]+s$/);
    await expect(working).toHaveText(/^Working · [1-9][0-9]*s$/, { timeout: 4000 });
    await page.screenshot({ path: `${shots}/desktop-working.png` });
    await input.press("Escape");
    await expect(panel.locator(".acp-status")).toHaveText("Stopped");
    await expect(working).toHaveCount(0);

    await input.fill("permission-diff");
    await input.press("Enter");
    await expect(working).toHaveText("Waiting for your approval");
    const approval = panel.getByRole("region", { name: "Agent approval" });
    await expect(approval.locator(".acp-patch")).toContainText("+hello from the agent");
    await page.screenshot({ path: `${shots}/desktop-permission.png` });
    await approval.getByRole("button", { name: "Allow once" }).click();
    await expect(log).toContainText("allow-once");
    await ready();

    await page.evaluate(async ({ command, args }) => {
      const agent = (window as any).__oxbit.kernel.services.get("agentACP");
      await agent.disconnect();
      agent.selection = { provider: "codex", command, args };
      await agent.connectSelected();
    }, { command: process.execPath, args: [fixture, "--no-images"] });
    await ready();
    await paste(page, PNG);
    await expect(panel.getByRole("alert")).toHaveText("This agent does not accept images");
    await expect(panel.locator(".acp-attachments .acp-image-item")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test.describe("phone composer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("coarse pointers send with the button and stack approval actions", async ({ page }) => {
    const app = await open(page);
    const { panel, input, log, ready } = app;
    try {
      await fs.mkdir(shots, { recursive: true });
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await page.evaluate(() => (window as any).__oxbit.workbench.run("agentACP.open"));
      await expect(input).toHaveAttribute("enterkeyhint", "enter");
      await expect(panel.locator(".acp-hint")).toHaveCount(0);
      await input.fill("hello");
      await input.press("Enter");
      await expect(input).toHaveValue("hello\n");
      await panel.getByRole("button", { name: "Send", exact: true }).tap();
      await expect(log).toContainText("Done.");
      await ready();
      await page.screenshot({ path: `${shots}/phone-composer.png` });

      await input.fill("permission-diff");
      await panel.getByRole("button", { name: "Send", exact: true }).tap();
      const approval = panel.getByRole("region", { name: "Agent approval" });
      await expect(approval.locator(".acp-patch")).toBeVisible();
      const card = (await approval.boundingBox())!;
      const boxes = await Promise.all(
        ["Allow once", "Reject", "Cancel"].map((name) =>
          approval.getByRole("button", { name, exact: true }).boundingBox()),
      );
      for (const [index, box] of boxes.entries()) {
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThan(card.width - 40);
        if (index) expect(box!.y).toBeGreaterThan(boxes[index - 1]!.y + boxes[index - 1]!.height - 1);
      }
      const bar = panel.getByRole("button", { name: /Agent needs your input/ });
      await expect(bar).toBeInViewport();
      expect((await bar.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await bar.boundingBox())!.y).toBeLessThan((await input.boundingBox())!.y);
      await page.screenshot({ path: `${shots}/phone-permission.png` });
      await bar.tap();
      await expect(approval.getByRole("button", { name: "Allow once" })).toBeFocused();
      await expect(approval.getByRole("button", { name: "Allow once" })).toBeInViewport();
      await approval.getByRole("button", { name: "Allow once" }).tap();
      await expect(log).toContainText("allow-once");
      await ready();
    } finally {
      await app.close();
    }
  });
});
