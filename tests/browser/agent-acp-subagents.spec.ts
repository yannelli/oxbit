import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";

test("dispatched subagents share a tree, child approvals, results and historical activity", async ({
  page,
}) => {
  page.setDefaultTimeout(15000);
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-subagents-browser-")),
  );
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "hello.txt"), "hello from disk\n");
  const runtime = await createRuntime({
    root,
    port: 0,
    dataDir: path.join(directory, "state"),
    settingsFile: path.join(directory, "settings.json"),
    projectsDir: path.join(directory, "projects"),
    pairingCode: "subagents",
    origins: ["http://127.0.0.1:9278"],
  });
  const openConversation = async () =>
    page.evaluate(() => (window as any).__oxbit.workbench.run("agentACP.open"));
  const openAgents = async () =>
    page.evaluate(() =>
      (window as any).__oxbit.workbench.run("agentACP.openAgents"),
    );
  try {
    await page.goto(`http://127.0.0.1:${runtime.port}`);
    await page.waitForFunction(() => (window as any).__oxbit?.ready);
    await page.evaluate(async (url) => {
      await (window as any).__oxbit.connectRuntime(url, "subagents");
    }, `http://127.0.0.1:${runtime.port}`);
    await page.waitForFunction(
      () => (window as any).__oxbit.runtime?.connected,
    );
    await page.evaluate(
      async ({ executable, fixture }) => {
        const z = (window as any).__oxbit;
        await z.runtime.request("workspace.trust", { trusted: true });
        await z.kernel.extensions.activate("oxbit.agent-acp");
        await z.kernel.configuration.set(
          "agentACP.codex.command",
          executable,
          "user",
        );
        await z.kernel.configuration.set(
          "agentACP.codex.args",
          JSON.stringify([fixture]),
          "user",
        );
        z.workbench.set({ sidebarWidth: 460 });
        await z.workbench.openFile("hello.txt", { preview: false });
        z.workbench.run("agentACP.open");
      },
      {
        executable: process.execPath,
        fixture: path.resolve("tests/fixtures/agent-acp/subagents.mjs"),
      },
    );
    const conversation = page.locator(
      ".acp-panel:not(.acp-agents-view):not(.acp-review-editor)",
    );
    await conversation
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(conversation.locator(".acp-status")).toHaveText("Ready");
    for (const dismiss of await page
      .getByRole("button", { name: "Dismiss notification" })
      .all())
      await dismiss.click();
    const composer = conversation.getByRole("textbox", {
      name: "Message agent",
    });
    await composer.fill("delegate");
    await composer.press("Control+Enter");
    await expect(conversation.locator(".acp-status")).toHaveText("Ready");
    const compact = conversation.getByRole("region", {
      name: "Conversation subagents",
    });
    await expect(compact.locator(".acp-agents-counts")).toHaveText(
      "1 active · 1 completed · 1 failed",
    );
    await expect(
      conversation.getByRole("button", {
        name: "New conversation",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(conversation.getByRole("log")).not.toContainText(
      "Child-only test output",
    );
    const reviewer = compact.getByRole("treeitem", {
      name: "Reviewer · Awaiting input",
      exact: true,
    });
    await expect(reviewer).toBeVisible();
    await reviewer.focus();
    await reviewer.press("ArrowRight");
    await reviewer.press("ArrowDown");
    await expect(
      compact.getByRole("treeitem", {
        name: "Test runner · Completed",
        exact: true,
      }),
    ).toBeFocused();
    await expect(
      compact.getByRole("region", { name: "Subagent details" }),
    ).toContainText("Child-only test output");
    await reviewer.click();
    await fs.mkdir("evidence/agent-acp/subagents", { recursive: true });
    await page.screenshot({
      path: "evidence/agent-acp/subagents/conversation-dark.png",
    });
    await conversation
      .locator(".acp-header")
      .getByRole("button", { name: "Open Agents", exact: true })
      .click();
    const agents = page.locator(".acp-agents-view");
    await expect(agents).toBeVisible();
    await expect(
      agents.getByRole("treeitem", {
        name: "Reviewer · Awaiting input",
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      agents.getByRole("region", { name: "Subagent details" }),
    ).toContainText("From subagent: Reviewer");
    await page.screenshot({
      path: "evidence/agent-acp/subagents/agents-dark.png",
    });
    await agents
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect(agents.getByLabel("File change diff")).toContainText(
      "+reviewed by child",
    );
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe(
      "hello from disk\n",
    );
    await agents
      .getByRole("button", { name: "Review in editor", exact: true })
      .click();
    const review = page.locator(".acp-review-editor");
    await expect(review).toContainText("From subagent: Reviewer");
    await review
      .getByRole("button", { name: "Apply change", exact: true })
      .click();
    await expect(agents.locator(".acp-agents-counts")).toHaveText(
      "0 active · 2 completed · 1 failed",
    );
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe(
      "reviewed by child\n",
    );
    await expect(
      agents.getByRole("region", { name: "Subagent details" }),
    ).toContainText("Review complete");
    await openConversation();
    await expect(compact.locator(".acp-agents-counts")).toHaveText(
      "0 active · 2 completed · 1 failed",
    );
    await expect(
      conversation.getByRole("button", {
        name: "New conversation",
        exact: true,
      }),
    ).toBeEnabled();
    await composer.fill("Draft after delegation");
    await page.evaluate(() =>
      (window as any).__oxbit.kernel.services
        .get("agentACP")
        .saveConversation(),
    );
    await page.reload();
    await page.waitForFunction(
      () =>
        (window as any).__oxbit?.ready &&
        (window as any).__oxbit.runtime?.connected,
    );
    await page.evaluate(async () => {
      const z = (window as any).__oxbit;
      await z.kernel.extensions.activate("oxbit.agent-acp");
      z.workbench.run("agentACP.open");
    });
    await expect(
      conversation.getByRole("button", { name: "Connect", exact: true }),
    ).toBeVisible();
    await conversation
      .getByRole("button", { name: "History", exact: true })
      .click();
    await expect(conversation.locator(".acp-history-entry")).toHaveCount(1);
    await conversation
      .getByRole("button", { name: "Read", exact: true })
      .click();
    await openAgents();
    await expect(agents).toContainText(
      "Historical activity. Live status has not been confirmed.",
    );
    await expect(agents.locator(".acp-agents-counts")).toHaveText(
      "0 active · 2 completed · 1 failed",
    );
    await openConversation();
    // History remains available for an archived conversation.
    if (
      !(await conversation
        .getByRole("button", { name: "Resume", exact: true })
        .isVisible())
    )
      await conversation
        .getByRole("button", { name: "History", exact: true })
        .click();
    await conversation
      .getByRole("button", { name: "Resume", exact: true })
      .click();
    await expect(conversation.locator(".acp-status")).toHaveText("Ready");
    await openAgents();
    await expect(agents.getByRole("treeitem")).toHaveCount(2); // Nested child remains collapsed.
    expect(
      await page.evaluate(
        () =>
          (window as any).__oxbit.kernel.services.get("agentACP").subagents
            .size,
      ),
    ).toBe(3);
    await openConversation();
    await expect(composer).toHaveValue("Draft after delegation");
    await openAgents();
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgents();
    const first = agents.getByRole("treeitem").first();
    await first.focus();
    await expect(first).toBeFocused();
    const overflow = await agents.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1,
    );
    expect(overflow).toBe(false);
    await page.screenshot({
      path: "evidence/agent-acp/subagents/phone-dark.png",
    });
    await page.evaluate(async () => {
      await (window as any).__oxbit.kernel.configuration.set(
        "workbench.colorTheme",
        "Paper (light)",
        "user",
      );
    });
    await page.screenshot({
      path: "evidence/agent-acp/subagents/phone-light.png",
    });
  } catch (error) {
    await page.screenshot({ path: "/tmp/oxbit-subagents-browser-failure.png" });
    await fs.writeFile(
      "/tmp/oxbit-subagents-browser-failure.txt",
      await page.locator("body").innerText(),
    );
    throw error;
  } finally {
    await page.close({ runBeforeUnload: false });
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
