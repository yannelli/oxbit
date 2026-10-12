import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";

const shots = "/tmp/oxbit-agents/fork-session";

test("Fork conversation forks the agent session and keeps the original in history", async ({ page }, info) => {
  page.setDefaultTimeout(15000);
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-fork-")));
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  const runtime = await createRuntime({
    root, port: 0, dataDir: path.join(directory, "state"),
    settingsFile: path.join(directory, "settings.json"), projectsDir: path.join(directory, "projects"),
    pairingCode: "acp-fork", origins: ["http://127.0.0.1:9278"],
  });
  try {
    await page.goto(`http://127.0.0.1:${runtime.port}`);
    await page.waitForFunction(() => (window as any).__oxbit?.ready);
    await page.evaluate(async (url) => (window as any).__oxbit.connectRuntime(url, "acp-fork"), `http://127.0.0.1:${runtime.port}`);
    await page.waitForFunction(() => (window as any).__oxbit.runtime?.connected);
    await page.evaluate(async ({ executable, fixture }) => {
      const z = (window as any).__oxbit;
      await z.runtime.request("workspace.trust", { trusted: true });
      await z.kernel.extensions.activate("oxbit.agent-acp");
      await z.kernel.configuration.set("agentACP.codex.command", executable, "user");
      await z.kernel.configuration.set("agentACP.codex.args", JSON.stringify([fixture, "--history"]), "user");
    }, { executable: process.execPath, fixture: path.resolve("tests/fixtures/agent-acp/agent.mjs") });
    // Opening the panel inside the async evaluate made Chromium drop its promise.
    await page.evaluate(() => (window as any).__oxbit.workbench.run("agentACP.open"));
    const panel = page.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)");
    const log = panel.getByRole("log");
    const ready = () => expect(panel.locator(".acp-status")).toHaveText("Ready");
    const send = async (text: string) => {
      await panel.getByRole("textbox", { name: "Message agent" }).fill(text);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await ready();
    };
    const actions = () => panel.getByRole("button", { name: "More agent actions", exact: true }).click();

    await panel.getByRole("button", { name: /^Start / }).click();
    await ready();
    await actions();
    await expect(panel.getByRole("menuitem", { name: "Fork conversation" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await send("Remember the blue door");
    const conversation = () => page.evaluate(() => (window as any).__oxbit.kernel.services.get("agentACP").activeConversation);
    const original = await conversation();

    await actions();
    await panel.getByRole("menuitem", { name: "Fork conversation" }).click();
    await expect(panel.locator(".acp-turn-note", { hasText: "Forked from “Remember the blue door”" })).toBeVisible();
    const forked = await conversation();
    expect(forked.id).not.toBe(original.id);
    expect(forked.sessionId).not.toBe(original.sessionId);
    await expect(log.locator(".acp-user-text")).toHaveText(["Remember the blue door"]);
    await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/${info.project.name}-forked.png` });

    await send("history");
    await expect(log).toContainText("History: Remember the blue door | history");
    const kept = await page.evaluate((id) => (window as any).__oxbit.kernel.services.get("agentACP").history.entries
      .find((entry: any) => entry.id === id)?.activity.filter((item: any) => item.kind === "message")
      .map((item: any) => item.message.text), original.id);
    expect(kept).toEqual(["Remember the blue door", "Hello from ACP. Done."]);
  } finally {
    await page.close({ runBeforeUnload: false });
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
