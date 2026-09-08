import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";
const id = "oxbit.agent-acp";
const ready = async (page: Page) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
};
const details = async (page: Page) => {
  await page.evaluate(() =>
    (window as any).__oxbit.workbench.openSidebar("extensions"),
  );
  await page
    .getByRole("button")
    .filter({ has: page.locator("strong", { hasText: /^Agent ACP$/ }) })
    .click();
  await expect(
    page.getByRole("heading", { name: "Agent ACP", exact: true }).first(),
  ).toBeVisible();
};
test("Agent ACP is opt-in for fresh and existing workspaces and persists enable/disable", async ({
  page,
}) => {
  await ready(page);
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__oxbit.kernel.extensions
          .list()
          .find((e: any) => e.manifest.id === id).state,
      id,
    ),
  ).toBe("disabled");
  expect(
    await page.evaluate(() =>
      (window as any).__oxbit.kernel.contributions
        .list()
        .some((c: any) => c.id === "agent-acp"),
    ),
  ).toBe(false);
  // Simulate an existing installation's explicit disabled list without Agent ACP.
  await page.evaluate(() =>
    (window as any).__oxbit.workbench.persistence.set("extension-disabled", [
      "orbitlabs.bundle-inspector",
    ]),
  );
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__oxbit.kernel.extensions
          .list()
          .find((e: any) => e.manifest.id === id).state,
      id,
    ),
  ).toBe("disabled");
  await details(page);
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Disable", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__oxbit.kernel.extensions
          .list()
          .find((e: any) => e.manifest.id === id).state,
      id,
    ),
  ).toBe("active");
  await page.evaluate(() =>
    (window as any).__oxbit.workbench.run("agentACP.open"),
  );
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Connect to a runtime workspace to use agents."),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "ACP provider" }).click();
  await expect(page.getByRole("option", { name: "Codex ACP" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Cursor ACP" })).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Amp Agent ACP" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await fs.mkdir("evidence/agent-acp", { recursive: true });
  await page.screenshot({ path: "evidence/agent-acp/desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() =>
    (window as any).__oxbit.workbench.run("agentACP.open"),
  );
  await page.getByRole("textbox", { name: "Message agent" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message agent" }),
  ).toBeFocused();
  const bounds = await page.locator(".acp-panel").boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "evidence/agent-acp/phone.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await details(page);
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await page.reload();
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__oxbit.kernel.extensions
          .list()
          .find((e: any) => e.manifest.id === id).state,
      id,
    ),
  ).toBe("disabled");
});

test("ACP conversations support approvals, editor context, tools, cancellation and lifecycle", async ({
  page,
}) => {
  const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-browser-")),
    ),
    root = path.join(directory, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "hello.txt"), "hello from disk\n");
  const runtime = await createRuntime({
    root,
    port: 0,
    dataDir: path.join(directory, "state"),
    settingsFile: path.join(directory, "settings.json"),
    projectsDir: path.join(directory, "projects"),
    pairingCode: "acp-browser-fixture",
    origins: ["http://127.0.0.1:9278"],
  });
  try {
    await page.goto(`http://127.0.0.1:${runtime.port}`);
    await page.waitForFunction(() => (window as any).__oxbit?.ready);
    await page.evaluate(async (url) => {
      await (window as any).__oxbit.connectRuntime(url, "acp-browser-fixture");
    }, `http://127.0.0.1:${runtime.port}`);
    await page.waitForFunction(
      () => (window as any).__oxbit.runtime?.connected,
    );
    // Runtime enforces trust and owner access even if an RPC is called outside the UI.
    expect(
      await page.evaluate(async () => {
        try {
          await (window as any).__oxbit.runtime.request("acp.start", {
            provider: "cursor",
          });
          return "unexpected";
        } catch (e: any) {
          return e.code;
        }
      }),
    ).toBe("UNTRUSTED");
    await page.evaluate(async () => {
      const z = (window as any).__oxbit;
      await z.runtime.trust(true);
      await z.kernel.extensions.activate("oxbit.agent-acp");
    });
    await page.evaluate(
      ({ command, args }) => {
        const z = (window as any).__oxbit;
        z.kernel.configuration.set("agentACP.codex.command", command, "user");
        z.kernel.configuration.set(
          "agentACP.codex.args",
          JSON.stringify(args),
          "user",
        );
        z.workbench.set({ sidebarWidth: 420 });
        z.workbench.openFile("hello.txt", { preview: false });
        z.workbench.run("agentACP.open");
      },
      {
        command: process.execPath,
        args: [path.resolve("tests/fixtures/agent-acp/agent.mjs")],
      },
    );
    expect(
      await page.evaluate(async () => {
        const z = (window as any).__oxbit,
          grant = await z.runtime.request("workspace.grant", {
            capabilities: ["extensions"],
          });
        const guest = new z.runtime.constructor(z.runtime.url, "default", {
          token: grant.token,
          persistToken: false,
        });
        try {
          await guest.connect();
          try {
            await guest.request("acp.start", { provider: "codex" });
            return "unexpected";
          } catch (error: any) {
            return error.code;
          }
        } finally {
          guest.dispose();
        }
      }),
    ).toBe("FORBIDDEN");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /^Ready$/ }),
    ).toBeVisible();
    const trustNotice = page.locator(".toasts .notification").filter({
      hasText: "Trust this workspace before executing tools",
    });
    if (await trustNotice.count())
      await trustNotice
        .getByRole("button", { name: "Dismiss notification" })
        .click();
    await page.locator(".acp-session-options > summary").click();
    const settings = page.locator(".acp-settings");
    await expect(settings.getByRole("combobox")).toHaveCount(5);
    await expect(
      page.getByRole("combobox", { name: "Agent mode", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Agent model", exact: true }),
    ).toHaveCount(0);
    for (const label of [
      "Permissions",
      "Session mode",
      "Model",
      "Reasoning",
      "Fast mode",
    ])
      await expect(
        settings
          .locator(".acp-setting-label")
          .getByText(label, { exact: true }),
      ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Message agent" })
      .fill("Draft survives settings changes");
    const model = settings.getByRole("combobox", {
      name: "Model",
      exact: true,
    });
    await model.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(settings).toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeDisabled();
    await expect(model).toContainText("Fast model");
    await expect(
      settings.getByRole("combobox", { name: "Reasoning" }),
    ).toContainText("Low");
    await expect(model).toBeFocused();
    await model.click();
    await page
      .getByRole("option", { name: "Unavailable model", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Model unavailable" }),
    ).toBeVisible();
    await expect(model).toContainText("Fast model");
    await expect(model).toBeEnabled();
    await expect(
      page.getByRole("textbox", { name: "Message agent" }),
    ).toHaveValue("Draft survives settings changes");
    await model.click();
    await page.getByRole("option", { name: "Model", exact: true }).click();
    await expect(settings).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".acp-panel").getByRole("alert")).toHaveCount(0);
    await fs.mkdir("evidence/agent-acp", { recursive: true });
    await page.screenshot({ path: "evidence/agent-acp/settings-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() =>
      (window as any).__oxbit.workbench.run("agentACP.open"),
    );
    const panelBounds = await page.locator(".acp-panel").boundingBox();
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(390);
    await expect(
      page.getByRole("textbox", { name: "Message agent" }),
    ).toBeInViewport();
    for (const control of await settings.getByRole("combobox").all()) {
      const bounds = await control.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    await model.click();
    await expect(
      page.getByRole("option", { name: "Fast model", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: "evidence/agent-acp/settings-phone.png" });
    await page.setViewportSize({ width: 1440, height: 900 });
    const send = async (text: string) => {
      await page.getByRole("textbox", { name: "Message agent" }).fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
    };
    await send("error");
    await expect(
      page.getByRole("status").filter({ hasText: /^Turn failed$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "Fixture prompt failed" }),
    ).toBeVisible();
    await send("config-update");
    await expect(
      settings.getByRole("combobox", { name: "Session mode", exact: true }),
    ).toContainText("Plan");
    await expect(
      page.getByRole("status").filter({ hasText: /^Ready$/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add context", exact: true }).click();
    await page
      .getByRole("button", { name: "Attach file", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Remove attachment hello.txt" }),
    ).toBeVisible();
    await send("Explain this file");
    await expect(
      page.getByRole("log").locator(".acp-context-item summary"),
    ).toContainText("hello.txt");
    await expect(
      page.getByRole("log").locator(".acp-context-item pre"),
    ).toHaveText("hello from disk\n");
    await expect(page.getByRole("log")).toContainText("Done.");
    await send("permission");
    await expect(page.getByText("Permission required")).toBeVisible();
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(page.getByRole("log")).toContainText("reject-once");
    await send("tools");
    await expect(page.getByText("Run fixture check")).toBeVisible();
    await page.getByText("Run fixture check").click();
    await expect(
      page.locator(".acp-card").filter({ hasText: "Run fixture check" }),
    ).toContainText("Terminal fixture ✓");
    await send(`write:${root}/hello.txt`);
    await expect(page.getByText("Review file change")).toBeVisible();
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe(
      "hello from disk\n",
    );
    await page.getByRole("button", { name: "Apply change" }).click();
    await expect
      .poll(() => fs.readFile(path.join(root, "hello.txt"), "utf8"))
      .toBe("agent edit\n");
    await send(`write:${root}/created.txt`);
    await expect(page.getByText("Review file change")).toBeVisible();
    await page.getByRole("button", { name: "Apply change" }).click();
    await expect
      .poll(() =>
        fs.readFile(path.join(root, "created.txt"), "utf8").catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
      )
      .toBe("agent edit\n");
    await page.evaluate(() =>
      (window as any).__oxbit.documents
        .get("hello.txt")
        .replace("unsaved work"),
    );
    await send(`write:${root}/hello.txt`);
    await expect(
      page.getByRole("alert").filter({ hasText: "unsaved edits" }),
    ).toBeVisible();
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe(
      "agent edit\n",
    );
    await send("questions");
    await page.getByRole("radio", { name: "Ask", exact: true }).check();
    await page.getByRole("button", { name: "Submit answers" }).click();
    await expect(page.getByRole("log")).toContainText("selectedOptionIds");
    await fs.mkdir("evidence/agent-acp", { recursive: true });
    await page.screenshot({ path: "evidence/agent-acp/conversation.png" });
    await send("wait");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /^Stopped$/ }),
    ).toBeVisible();
    await page.evaluate(() =>
      (window as any).__oxbit.kernel.extensions.disable("oxbit.agent-acp"),
    );
    await expect(page.locator(".acp-panel")).toHaveCount(0);
    await page.evaluate(async () => {
      const z = (window as any).__oxbit;
      await z.kernel.extensions.activate("oxbit.agent-acp");
      z.workbench.run("agentACP.open");
    });
    await expect(
      page.getByRole("button", { name: "Connect", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /^Ready$/ }),
    ).toBeVisible();
    await page.evaluate(() => (window as any).__oxbit.runtime.trust(false));
    await expect(
      page.getByRole("status").filter({ hasText: "trust was revoked" }),
    ).toBeVisible();
  } finally {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
