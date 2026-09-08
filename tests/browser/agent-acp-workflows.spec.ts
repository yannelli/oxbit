import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";

test("ACP history, rich activity, context snapshots, editor review and guarded undo", async ({
  page,
}) => {
  page.setDefaultTimeout(15000);
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-workflows-")),
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
    pairingCode: "acp-workflows",
    origins: ["http://127.0.0.1:9278"],
  });
  try {
    await page.goto(`http://127.0.0.1:${runtime.port}`);
    await page.waitForFunction(() => (window as any).__oxbit?.ready);
    await page.evaluate(async (url) => {
      await (window as any).__oxbit.connectRuntime(url, "acp-workflows");
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
          JSON.stringify([fixture, "--history"]),
          "user",
        );
        z.workbench.set({ sidebarWidth: 450 });
        await z.workbench.openFile("hello.txt", { preview: false });
        z.workbench.run("agentACP.open");
      },
      {
        url: `http://127.0.0.1:${runtime.port}`,
        executable: process.execPath,
        fixture: path.resolve("tests/fixtures/agent-acp/agent.mjs"),
      },
    );
    const panel = page.locator(".acp-panel:not(.acp-review-editor)");
    const composer = panel.getByRole("textbox", { name: "Message agent" });
    const ready = () =>
      expect(panel.locator(".acp-status")).toHaveText("Ready");
    const send = async (text: string) => {
      await composer.fill(text);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await ready();
    };
    await fs.mkdir("evidence/agent-acp/workflows", { recursive: true });
    await panel.screenshot({ path: "evidence/agent-acp/workflows/disconnected-dark.png" });
    await panel.getByRole("button", { name: "Setup", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "Agent executable" })).toBeVisible();
    await panel.screenshot({ path: "evidence/agent-acp/workflows/setup-dark.png" });
    await panel.getByRole("button", { name: "Setup", exact: true }).click();
    await panel.getByRole("button", { name: "Connect", exact: true }).click();
    await ready();
    for (const dismiss of await page.getByRole("button", { name: "Dismiss notification" }).all()) await dismiss.click();
    expect((await panel.locator(".acp-header").boundingBox())!.height).toBeLessThanOrEqual(48);
    expect((await panel.locator(".acp-composer").boundingBox())!.height).toBeLessThanOrEqual(180);
    await expect(panel.getByRole("button", { name: "Attach diagnostics", exact: true })).toBeHidden();
    await expect(panel.locator(".acp-context-budget")).toBeHidden();
    await composer.fill("rich");
    await composer.press("Control+Enter");
    await ready();
    await expect(
      panel.getByRole("heading", { name: "Review result" }),
    ).toBeVisible();
    await expect(panel.locator(".acp-markdown pre code")).toHaveText(
      "const ready = true;\n",
    );
    expect(
      await page.evaluate(() => (window as any).acpInjected),
    ).toBeUndefined();
    await expect(
      panel.locator(".acp-markdown img, .acp-markdown script"),
    ).toHaveCount(0);
    const ordered = await panel.getByRole("log").innerText();
    expect(ordered.indexOf("Inspect editor snapshot")).toBeGreaterThan(
      ordered.indexOf("Review result"),
    );
    expect(
      ordered.indexOf("The check completed after the tool."),
    ).toBeGreaterThan(ordered.indexOf("Inspect editor snapshot"));
    await fs.mkdir("evidence/agent-acp/workflows", { recursive: true });
    await panel.locator(".acp-content").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: "evidence/agent-acp/workflows/activity-dark.png",
    });

    await panel
      .getByRole("button", { name: "Add context", exact: true })
      .click();
    await expect(panel.getByRole("button", { name: "Attach diagnostics", exact: true })).toBeFocused();
    await page.screenshot({ path: "evidence/agent-acp/workflows/context-menu-dark.png" });
    await page.keyboard.press("Escape");
    await expect(panel.locator(".acp-context-menu")).toBeHidden();
    await panel.getByRole("button", { name: "Add context", exact: true }).click();
    await panel
      .getByRole("button", { name: "+ hello.txt", exact: true })
      .click();
    await expect(panel.locator(".acp-context-chip")).toHaveCount(1);
    await expect(panel.locator(".acp-context-menu")).toBeHidden();
    await expect(panel.getByRole("button", { name: "Add context", exact: true })).toBeFocused();
    await panel.locator(".acp-context-chip summary").click();
    await expect(panel.locator(".acp-context-chip pre")).toHaveText(
      "hello from disk\n",
    );
    await send("context-inspect");
    await expect(panel.getByRole("log")).toContainText('"type":"resource"');
    await expect(panel.getByRole("log")).toContainText(
      "Editor snapshot: hello.txt",
    );

    await composer.fill(`write:${path.join(root, "hello.txt")}`);
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByLabel("File change diff")).toContainText(
      "-hello from disk",
    );
    await expect(panel.getByLabel("File change diff")).toContainText(
      "+agent edit",
    );
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe(
      "hello from disk\n",
    );
    await panel
      .getByRole("button", { name: "Review in editor", exact: true })
      .click();
    const review = page.locator(".acp-review-editor");
    await expect(review.getByLabel("File change diff")).toBeVisible();
    await page.screenshot({
      path: "evidence/agent-acp/workflows/editor-review-dark.png",
    });
    await review
      .getByRole("button", { name: "Apply change", exact: true })
      .click();
    await ready();
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe(
      "agent edit\n",
    );
    await panel
      .getByRole("region", { name: "Reviewed agent edits" })
      .locator("summary")
      .click();
    await panel
      .getByRole("button", { name: "Undo this edit", exact: true })
      .click();
    await expect
      .poll(() => fs.readFile(path.join(root, "hello.txt"), "utf8"))
      .toBe("hello from disk\n");

    await composer.fill("Follow-up saved draft");
    await panel
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await ready();
    await expect(composer).toHaveValue("");
    await panel.getByRole("button", { name: "History", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "Search conversations" })
      .fill("write:");
    await expect(panel.locator(".acp-history-entry")).toHaveCount(1);
    await panel.getByRole("button", { name: "Resume", exact: true }).click();
    await ready();
    await expect(composer).toHaveValue("Follow-up saved draft");
    const session = await page.evaluate(
      () =>
        (window as any).__oxbit.kernel.services.get("agentACP").connection
          .sessionId,
    );
    await page.evaluate(async () =>
      (window as any).__oxbit.kernel.services
        .get("agentACP")
        .saveConversation(),
    );
    await page.reload();
    await page.waitForFunction(() => (window as any).__oxbit?.ready);
    await page.evaluate(async () => {
      const z = (window as any).__oxbit;
      await z.kernel.extensions.activate("oxbit.agent-acp");
      z.workbench.run("agentACP.open");
    });
    await expect(
      panel.getByRole("button", { name: "Connect", exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "History", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "Search conversations" })
      .fill("write:");
    await expect(panel.locator(".acp-history-entry")).toHaveCount(1);
    await panel.getByRole("button", { name: "Resume", exact: true }).click();
    await ready();
    expect(
      await page.evaluate(
        () =>
          (window as any).__oxbit.kernel.services.get("agentACP").connection
            .sessionId,
      ),
    ).toBe(session);
    await expect(composer).toHaveValue("Follow-up saved draft");
    await page.screenshot({
      path: "evidence/agent-acp/workflows/history-dark.png",
    });
    await panel.getByRole("button", { name: "History", exact: true }).click();
    await send("rich");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() =>
      (window as any).__oxbit.workbench.run("agentACP.open"),
    );
    await composer.click();
    await expect(composer).toBeFocused();
    const bounds = await panel.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: "evidence/agent-acp/workflows/phone-dark.png",
    });
    await page.evaluate(() =>
      (window as any).__oxbit.kernel.configuration.set(
        "workbench.colorTheme",
        "Paper (light)",
        "user",
      ),
    );
    await page.screenshot({
      path: "evidence/agent-acp/workflows/phone-light.png",
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => {
      const z = (window as any).__oxbit;
      await z.kernel.configuration.set("workbench.colorTheme", "Graphite (dark)", "user");
      z.workbench.movePanel("agent-acp", { container: "bottom" });
      z.workbench.set({ panelHeight: 450 });
    });
    await ready();
    expect((await panel.locator(".acp-header").boundingBox())!.height).toBeLessThanOrEqual(48);
    expect((await panel.locator(".acp-content").boundingBox())!.height).toBeGreaterThan(200);
    await composer.fill("Explain the next change to hello.txt");
    await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    await panel.screenshot({ path: "evidence/agent-acp/workflows/bottom-dark.png" });
    await panel.getByRole("button", { name: "Add context", exact: true }).click();
    await expect(panel.locator(".acp-context-menu")).toBeInViewport();
    await composer.click();
    await expect(panel.locator(".acp-context-menu")).toBeHidden();
    await panel.getByRole("button", { name: "Setup", exact: true }).click();
    await panel.getByRole("button", { name: "History", exact: true }).click();
    await panel.locator(".acp-session-options > summary").click();
    await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    expect(await panel.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  } catch (error) {
    await page
      .screenshot({ path: "/tmp/oxbit-acp-workflow-failure.png" })
      .catch(() => {});
    await fs.writeFile(
      "/tmp/oxbit-acp-workflow-failure.txt",
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    throw error;
  } finally {
    await page.close({ runBeforeUnload: false });
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
