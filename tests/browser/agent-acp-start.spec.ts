import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { platformTarget } from "../../apps/runtime/src/acp-registry.js";
import { createRuntime } from "../../apps/runtime/src/runtime.js";
import { buildArchive, registryDocument, serve } from "../fixtures/agent-acp-registry/server.mjs";

const shots = "/tmp/oxbit-agents/panel-start";
const builtins = ["Codex ACP", "Claude Agent", "Gemini CLI", "GitHub Copilot", "Cursor ACP", "Amp Agent ACP"];
const listing = {
  fetchedAt: "2026-10-10T00:00:00.000Z",
  agents: [
    { id: "claude-acp", name: "Claude Agent", version: "0.89.1", description: "ACP wrapper for Anthropic's Claude", distribution: "npx", available: true, builtin: "claude" },
    { id: "opencode", name: "OpenCode", version: "1.18.35", description: "The open source coding agent", distribution: "binary", available: true },
    { id: "goose", name: "goose", version: "1.54.0", description: "A local, extensible agent", distribution: "binary", available: false },
  ],
};

async function boot(page: Page, pairingCode: string, acpRegistryUrl?: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-start-")));
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "hello.txt"), "hello\n");
  const runtime = await createRuntime({
    root, port: 0, dataDir: path.join(directory, "state"),
    settingsFile: path.join(directory, "settings.json"), projectsDir: path.join(directory, "projects"),
    pairingCode, origins: ["http://127.0.0.1:9278"], acpRegistryUrl,
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
const mockRuntime = (page: Page) =>
  page.evaluate((registry) => {
    const z = (window as any).__oxbit;
    const original = z.runtime.request.bind(z.runtime);
    (window as any).__starts = [];
    z.runtime.request = (method: string, params: any, options: any) => {
      if (method === "acp.registry") return Promise.resolve(registry);
      if (method === "acp.start" && params.provider !== "codex") {
        (window as any).__starts.push(params);
        return Promise.reject(new Error("Choose Codex, Cursor, or Amp"));
      }
      return original(method, params, options);
    };
  }, listing);
const setting = (page: Page, id: string) =>
  page.evaluate((id) => (window as any).__oxbit.kernel.configuration.get(id), id);
const selection = (page: Page) =>
  page.evaluate(() => (window as any).__oxbit.kernel.services.get("agentACP").selection);

test("the picker lists built-ins, persists the choice, and names unknown agents by ID", async ({ page }) => {
  const { panel, close } = await boot(page, "acp-start-picker");
  try {
    const picker = panel.getByRole("radiogroup", { name: "Agent", exact: true });
    for (const name of builtins) await expect(picker.getByRole("radio", { name })).toBeVisible();
    await expect(picker.getByRole("radio")).toHaveCount(6);
    await expect(picker.getByRole("radio", { name: "Codex ACP" })).toHaveAttribute("aria-checked", "true");
    await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/desktop-1-picker.png` });
    await picker.getByRole("radio", { name: "Claude Agent" }).click();
    await expect(picker.getByRole("radio", { name: "Claude Agent" })).toHaveAttribute("aria-checked", "true");
    await expect(panel.getByRole("button", { name: "Start Claude Agent" })).toBeEnabled();
    expect(await setting(page, "agentACP.provider")).toBe("claude");
    expect(await selection(page)).toEqual({ provider: "claude" });
    await page.reload();
    await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected);
    await page.evaluate(async () => {
      const z = (window as any).__oxbit;
      await z.kernel.extensions.activate("oxbit.agent-acp");
      z.workbench.run("agentACP.open");
    });
    await expect(picker.getByRole("radio", { name: "Claude Agent" })).toHaveAttribute("aria-checked", "true");
    await page.evaluate(() => (window as any).__oxbit.kernel.configuration.set("agentACP.provider", "mystery-agent", "user"));
    await page.evaluate(() => (window as any).__oxbit.kernel.services.get("agentACP").changed());
    await expect(picker.getByRole("radio", { name: "mystery-agent" })).toHaveAttribute("aria-checked", "true");
    await expect(panel.getByRole("button", { name: "Start mystery-agent" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (window as any).__oxbit.workbench.run("agentACP.open"));
    await expect(panel.getByRole("heading", { name: "Choose an agent" })).toBeInViewport();
    await expect(panel.getByRole("radio", { name: "Codex ACP" })).toBeInViewport();
    await page.screenshot({ path: `${shots}/phone-1-picker.png` });
  } finally {
    await close();
  }
});

test("the registry browser filters, selects, and maps the old runtime error", async ({ page }) => {
  const { panel, close } = await boot(page, "acp-start-registry");
  try {
    await mockRuntime(page);
    await panel.getByRole("button", { name: /More agents…/ }).click();
    const registry = panel.getByRole("region", { name: "ACP Registry" });
    await expect(registry.locator(".acp-registry-entry")).toHaveCount(3);
    await expect(registry.getByRole("button", { name: /goose/ })).toBeDisabled();
    await registry.getByRole("textbox", { name: "Search agents" }).fill("open source");
    await expect(registry.locator(".acp-registry-entry")).toHaveCount(1);
    const opencode = registry.getByRole("button", { name: /OpenCode/ });
    await expect(opencode).toContainText("1.18.35");
    await expect(opencode).toContainText("binary");
    await expect(opencode).toContainText("The open source coding agent");
    await registry.getByRole("textbox", { name: "Search agents" }).fill("");
    await page.screenshot({ path: `${shots}/desktop-2-registry.png` });
    await opencode.click();
    await expect(registry).toBeHidden();
    const picker = panel.getByRole("radiogroup", { name: "Agent", exact: true });
    await expect(picker.getByRole("radio", { name: "OpenCode" })).toHaveAttribute("aria-checked", "true");
    expect(await setting(page, "agentACP.provider")).toBe("opencode");
    expect(await selection(page)).toEqual({ provider: "opencode", registry: { id: "opencode" } });
    await panel.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText(
      "This runtime does not support OpenCode. Update Oxbit on the runtime host.",
    );
    expect(await page.evaluate(() => (window as any).__starts)).toEqual([
      { provider: "opencode", registry: { id: "opencode" }, clientCapabilities: { editorTools: true } },
    ]);
    await panel.getByRole("button", { name: /More agents…/ }).click();
    await registry.getByRole("button", { name: /Claude Agent/ }).click();
    await expect(picker.getByRole("radio", { name: "Claude Agent" })).toHaveAttribute("aria-checked", "true");
    expect(await selection(page)).toEqual({ provider: "claude" });
  } finally {
    await close();
  }
});

test("a custom agent stores parsed arguments as the JSON setting", async ({ page }) => {
  const { panel, close } = await boot(page, "acp-start-custom");
  try {
    await mockRuntime(page);
    await panel.getByRole("button", { name: /Custom agent…/ }).click();
    const form = panel.getByRole("form", { name: "Custom agent" });
    await form.getByRole("textbox", { name: "Agent name" }).fill("Fixture agent");
    await form.getByRole("textbox", { name: "Agent executable" }).fill("/opt/agent bin/run");
    await form.getByRole("textbox", { name: "Agent arguments" }).fill(`acp --label "two words" 'it''s'`);
    await form.getByRole("button", { name: "Use custom agent" }).click();
    await expect(form).toBeHidden();
    expect(JSON.parse(await setting(page, "agentACP.custom.args"))).toEqual(["acp", "--label", "two words", "its"]);
    expect(await setting(page, "agentACP.custom.command")).toBe("/opt/agent bin/run");
    expect(await selection(page)).toEqual({
      provider: "custom", name: "Fixture agent", command: "/opt/agent bin/run", args: ["acp", "--label", "two words", "its"],
    });
    await expect(panel.getByRole("radio", { name: "Fixture agent" })).toHaveAttribute("aria-checked", "true");
    await panel.getByRole("button", { name: "More agent actions" }).click();
    await panel.getByRole("menuitem", { name: "Agent setup" }).click();
    await expect(panel.locator(".acp-header").getByRole("textbox", { name: "Agent arguments" })).toHaveValue(
      'acp --label "two words" its',
    );
    await panel.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText(
      "This runtime does not support Fixture agent. Update Oxbit on the runtime host.",
    );
  } finally {
    await close();
  }
});

test("the status item and a toast report a turn that ends while the panel is hidden", async ({ page }) => {
  const { panel, close } = await boot(page, "acp-start-attention");
  try {
    const item = page.locator(".statusbar .acp-status-item");
    await expect(item).toHaveCount(0);
    await panel.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(panel.locator(".acp-status")).toHaveText("Ready");
    await expect(item).toHaveText("Agent ready");
    for (const dismiss of await page.getByRole("button", { name: "Dismiss notification" }).all()) await dismiss.click();
    await page.screenshot({ path: `${shots}/desktop-3-connected.png` });
    await panel.getByRole("button", { name: "More agent actions" }).click();
    await expect(panel.getByRole("menu")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/desktop-4-menu.png` });
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const z = (window as any).__oxbit;
      (window as any).__badges = [];
      z.workbench.panelVisible = (id: string) => id !== "agent-acp";
      z.workbench.setViewBadge = (id: string, badge: unknown) => (window as any).__badges.push([id, badge ?? null]);
    });
    await panel.getByRole("textbox", { name: "Message agent" }).fill("hello");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    const toast = page.locator(".toasts .notification").filter({ hasText: "Agent finished" });
    await expect(toast).toBeVisible();
    await expect(item).toHaveText("Agent ready");
    expect(await page.evaluate(() => (window as any).__badges.at(-1))).toEqual([
      "agent-acp", { count: 0, label: "Agent finished", tone: "info" },
    ]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/desktop-5-toast.png` });
    await page.evaluate(() => delete (window as any).__oxbit.workbench.panelVisible);
    await toast.getByRole("button", { name: "Open Agent" }).click();
    expect(await page.evaluate(() => (window as any).__badges.at(-1))).toEqual(["agent-acp", null]);
    await page.evaluate(() => (window as any).__oxbit.workbench.openSidebar("explorer"));
    await item.click();
    await expect(panel.locator(".acp-status")).toHaveText("Ready");
    await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (window as any).__oxbit.workbench.run("agentACP.open"));
    await expect(panel.getByRole("textbox", { name: "Message agent" })).toBeInViewport();
    await page.screenshot({ path: `${shots}/phone-2-connected.png` });
  } finally {
    await close();
  }
});

test("a registry binary agent installs through the runtime and its request badges the Agent button", async ({ page }) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-archive-"));
  const archive = buildArchive(dir);
  const binary = (sha256?: string) => ({
    [platformTarget()!]: { archive: `${host.base}/agent.tar.gz`, cmd: "./bin/agent", ...(sha256 ? { sha256 } : {}) },
  });
  const host = await serve({
    "/agent.tar.gz": () => ({ body: archive.data }),
    "/registry.json": () => ({
      headers: { "content-type": "application/json" },
      body: registryDocument([
        { id: "fixture-binary", name: "Fixture Binary", version: "1.0.0", description: "Runs the ACP fixture", distribution: { binary: binary(archive.sha256) } },
        { id: "no-checksum", name: "No Checksum", version: "1.0.0", description: "Ships without a checksum", distribution: { binary: binary() } },
      ]),
    }),
  });
  const { panel, close } = await boot(page, "acp-start-binary", `${host.base}/registry.json`);
  try {
    await panel.getByRole("button", { name: /More agents…/ }).click();
    const registry = panel.getByRole("region", { name: "ACP Registry" });
    await expect(registry.locator(".acp-registry-entry")).toHaveCount(2);
    await expect(registry.getByRole("button", { name: /No Checksum/ })).toBeDisabled();
    await expect(registry.locator(".acp-registry-reason")).toHaveText("The registry publishes no checksum for this build");
    await registry.getByRole("button", { name: /Fixture Binary/ }).click();
    await panel.getByRole("textbox", { name: "Message agent" }).fill("permission");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByText("Permission required")).toBeVisible();
    expect(host.hits["/agent.tar.gz"]).toBe(1);
    const views = page.getByRole("navigation", { name: "Primary views" });
    await page.evaluate(() => (window as any).__oxbit.workbench.openPanel("agent-acp-agents"));
    await expect(panel).toBeHidden();
    const agent = views.getByRole("button", { name: "Agent ACP, Agent needs input", exact: true });
    await expect(agent.locator(".badge.badge-attention")).toHaveText("1");
    await agent.click();
    await panel.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(panel.getByRole("log")).toContainText("reject-once");
    await expect(views.getByRole("button", { name: "Agent ACP", exact: true }).locator(".badge")).toHaveCount(0);
  } finally {
    await close();
    await host.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
