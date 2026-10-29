import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";

const fixture = path.resolve("tests/fixtures/agent-acp/agent.mjs");
const shots = "/tmp/oxbit-agents/review-queue";
const files = ["a.txt", "b.txt", "c.txt"];

async function open(page: Page) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-review-")));
  const root = path.join(directory, "workspace");
  await fs.mkdir(root, { recursive: true });
  for (const file of files) await fs.writeFile(path.join(root, file), `${file} before\n`);
  const runtime = await createRuntime({
    root, port: 0, dataDir: path.join(directory, "state"),
    settingsFile: path.join(directory, "settings.json"),
    projectsDir: path.join(directory, "projects"), pairingCode: "acp-review",
  });
  await page.goto(`http://127.0.0.1:${runtime.port}`);
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async (url) => {
    await (window as any).__oxbit.connectRuntime(url, "acp-review");
  }, `http://127.0.0.1:${runtime.port}`);
  await page.waitForFunction(() => (window as any).__oxbit.runtime?.connected);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.runtime.trust(true);
    await z.kernel.extensions.activate("oxbit.agent-acp");
  });
  // Opening the panel inside the async evaluate made Chromium drop its promise in 3 of 80 runs.
  await page.evaluate(({ command, args }) => {
    const z = (window as any).__oxbit;
    z.kernel.services.get("agentACP").selection = { provider: "codex", command, args };
    z.workbench.set({ sidebarWidth: 420 });
    z.workbench.run("agentACP.open");
  }, { command: process.execPath, args: [fixture] });
  const panel = page.locator(".acp-panel").first();
  const input = panel.getByRole("textbox", { name: "Message agent" });
  return {
    panel,
    input,
    log: panel.getByRole("log"),
    disk: () => Promise.all(files.map((file) => fs.readFile(path.join(root, file), "utf8"))),
    async send(text: string) {
      await input.fill(text);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
    },
    writes: `writes:${files.map((file) => path.join(root, file)).join(",")}`,
    ready: () => expect(panel.locator(".acp-status")).toHaveText("Ready"),
    async close() {
      await page.goto("about:blank");
      await runtime.close();
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

test("Apply all, Undo all and Reject all review several agent writes at once", async ({ page }, info) => {
  const app = await open(page);
  const { panel } = app;
  try {
    await fs.mkdir(shots, { recursive: true });
    await app.send(app.writes);
    const bar = panel.getByRole("region", { name: "Pending file changes" });
    await expect(bar).toContainText("3 file changes");
    await expect(panel.getByText("Review file change")).toHaveCount(3);
    await bar.screenshot({ path: `${shots}/${info.project.name}-review-all.png` });
    const order = await panel.locator(".acp-approval > p").allTextContents();
    expect([...order].sort()).toEqual(files);
    await bar.getByRole("button", { name: "Apply all" }).click();
    await expect.poll(app.disk).toEqual(files.map((file) => `agent edit ${file}\n`));
    expect(await page.evaluate(() => (window as any).__oxbit.workbench.panelVisible("agent-acp"))).toBe(true);
    await app.ready();
    await expect(bar).toBeHidden();

    const edits = panel.getByRole("region", { name: "Reviewed agent edits" });
    await expect(edits.locator("details > summary")).toHaveText(order.map((file) => `${file} · Applied`));
    await edits.screenshot({ path: `${shots}/${info.project.name}-undo-all.png` });
    await edits.getByRole("button", { name: "Undo all" }).click();
    await expect(edits.locator("details > summary")).toHaveText(order.map((file) => `${file} · Undone`));
    await expect(edits.getByRole("button", { name: "Undo all" })).toBeHidden();
    expect(await app.disk()).toEqual(files.map((file) => `${file} before\n`));

    await app.send(app.writes);
    await expect(bar).toContainText("3 file changes");
    await bar.getByRole("button", { name: "Reject all" }).click();
    await app.ready();
    await expect(panel.getByText("Review file change")).toHaveCount(0);
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(await app.disk()).toEqual(files.map((file) => `${file} before\n`));
  } finally {
    await app.close();
  }
});

test("moving a queued message up runs it first", async ({ page }, info) => {
  const app = await open(page);
  const { panel } = app;
  try {
    await fs.mkdir(shots, { recursive: true });
    await app.send("wait");
    await expect(panel.locator(".acp-status")).toHaveText("Working…");
    for (const text of ["queued first", "queued second"]) {
      await app.input.fill(text);
      await panel.getByRole("button", { name: "Queue message" }).click();
    }
    const queue = panel.getByRole("region", { name: "Queued messages" });
    const items = queue.locator(".acp-queue-item");
    await expect(items).toHaveText([/queued first/, /queued second/]);
    await expect(items.first().getByRole("button", { name: "Move queued message up" })).toHaveCount(0);
    await expect(items.last().getByRole("button", { name: "Move queued message down" })).toHaveCount(0);
    await queue.screenshot({ path: `${shots}/${info.project.name}-queue.png` });
    await items.last().getByRole("button", { name: "Move queued message up" }).click();
    await expect(items).toHaveText([/1\. queued second/, /2\. queued first/]);

    await items.first().getByRole("button", { name: "Edit queued message" }).focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(items).toHaveText([/queued first/, /queued second/]);
    await expect(items.last().getByRole("button", { name: "Move queued message up" })).toBeFocused();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(items).toHaveText([/queued second/, /queued first/]);
    await expect(items.first().getByRole("button", { name: "Move queued message down" })).toBeFocused();

    await panel.getByRole("button", { name: "Stop", exact: true }).click();
    await queue.getByRole("button", { name: "Run queue" }).click();
    await expect(app.log.locator(".acp-user-text")).toHaveText(["wait", "queued second", "queued first"]);
    await app.ready();
    await expect(queue).toBeHidden();
  } finally {
    await app.close();
  }
});

test("Auto-apply edits applies agent writes without review, keeps Undo all and leaves permissions manual", async ({ page }, info) => {
  const app = await open(page);
  const { panel } = app;
  const panelShots = "/tmp/oxbit-agent2/panel-shots";
  try {
    await fs.mkdir(panelShots, { recursive: true });
    const toggle = panel.getByRole("button", { name: "Auto-apply edits", exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveAttribute("data-tooltip", "Auto-apply edits: off");
    await panel.screenshot({ path: `${panelShots}/${info.project.name}-auto-apply-off.png` });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveAttribute("data-tooltip", "Auto-apply edits: on");
    await expect(toggle).toBeInViewport();
    await panel.screenshot({ path: `${panelShots}/${info.project.name}-auto-apply-on.png` });

    await app.send(app.writes);
    await expect.poll(app.disk).toEqual(files.map((file) => `agent edit ${file}\n`));
    await app.ready();
    await expect(panel.getByText("Review file change")).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "Pending file changes" })).toHaveCount(0);
    await expect(toggle).toBeInViewport();
    await panel.screenshot({ path: `${panelShots}/${info.project.name}-auto-apply-connected.png` });
    const edits = panel.getByRole("region", { name: "Reviewed agent edits" });
    const summaries = edits.locator("details > summary");
    await expect(summaries).toHaveText(files.map(() => / · Applied$/));
    expect((await summaries.allTextContents()).map((text) => text.split(" · ")[0]).sort()).toEqual(files);
    await summaries.first().click();
    await expect(edits.getByLabel("File change diff").first()).toContainText("+agent edit");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await edits.screenshot({ path: `${panelShots}/${info.project.name}-auto-applied-edits.png` });
    await edits.getByRole("button", { name: "Undo all" }).click();
    await expect(summaries).toHaveText(files.map(() => / · Undone$/));
    expect(await app.disk()).toEqual(files.map((file) => `${file} before\n`));

    await app.send("permission");
    const approval = panel.getByRole("region", { name: "Agent approval" });
    await expect(approval).toContainText("Permission required");
    await approval.getByRole("button", { name: "Allow once" }).click();
    await app.ready();
    await expect(app.log).toContainText("allow-once");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await app.send(app.writes);
    await expect(panel.getByText("Review file change")).toHaveCount(3);
    await panel.getByRole("region", { name: "Pending file changes" }).getByRole("button", { name: "Reject all" }).click();
    await app.ready();
    expect(await app.disk()).toEqual(files.map((file) => `${file} before\n`));
  } finally {
    await app.close();
  }
});
