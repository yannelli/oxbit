import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";

const shots = "/tmp/oxbit-agents/checkpoints";

async function boot(page: Page, pairingCode: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-checkpoints-")));
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "hello.txt"), "hello\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Oxbit Test", "-c", "user.email=oxbit@example.test", ...args], { cwd: root });
  git("init", "--initial-branch=main");
  git("add", "-A");
  git("commit", "-m", "base");
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
    root,
    head: () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
    panel: page.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)"),
    close: async () => {
      await page.close({ runBeforeUnload: false });
      await runtime.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
const contents = (file: string) =>
  fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

test("Restore checkpoint puts files back to before the message", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { root, head, panel, close } = await boot(page, "acp-checkpoints");
  try {
    const base = head();
    await fs.mkdir(shots, { recursive: true });
    const status = panel.locator(".acp-status");
    await panel.getByRole("button", { name: /^Start / }).click();
    await expect(status).toHaveText("Ready");
    const turn = async (file: string) => {
      await panel.getByRole("textbox", { name: "Message agent" }).fill(`write:${file}`);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await expect(panel.getByText("Review file change")).toBeVisible();
      await panel.getByRole("button", { name: "Apply change" }).click();
      await expect.poll(() => contents(file)).toBe("agent edit\n");
      await expect(status).toHaveText("Ready");
      // Applying opens the file; on phones that replaces the agent panel.
      await page.evaluate(() => (window as any).__oxbit.workbench.run("agentACP.open"));
    };
    const restore = panel.getByRole("button", { name: "Restore checkpoint" });
    const note = panel.locator(".acp-turn-note", { hasText: "Restored files to before" });

    await turn(path.join(root, "hello.txt"));
    await expect(restore).toHaveCount(1);
    await expect(restore).toBeEnabled();
    await restore.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/desktop-restore-button.png` });
    await restore.click();
    await expect.poll(() => contents(path.join(root, "hello.txt"))).toBe("hello\n");
    await expect(note).toHaveCount(1);
    await expect(note).toContainText("write:");
    await expect(restore).toHaveCount(0);
    await page.screenshot({ path: `${shots}/desktop-restored-note.png` });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (window as any).__oxbit.workbench.run("agentACP.open"));
    await turn(path.join(root, "created.txt"));
    await expect(restore).toHaveCount(2);
    await restore.last().evaluate((button) => button.closest("article")!.scrollIntoView({ block: "center" }));
    await expect(restore.last()).toBeInViewport();
    await page.screenshot({ path: `${shots}/phone-restore-button.png` });
    await restore.last().click();
    await expect.poll(() => contents(path.join(root, "created.txt"))).toBeUndefined();
    expect(await contents(path.join(root, "hello.txt"))).toBe("hello\n");
    await expect(note).toHaveCount(2);
    await note.last().evaluate((item) => item.scrollIntoView({ block: "center" }));
    await expect(note.last()).toBeInViewport();
    await page.screenshot({ path: `${shots}/phone-restored-note.png` });
    expect(head()).toBe(base);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString()).toBe("");
  } finally {
    await close();
  }
});
