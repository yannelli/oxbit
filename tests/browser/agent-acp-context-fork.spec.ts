import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";

const fixture = path.resolve("tests/fixtures/agent-acp/agent.mjs");
const shots = "/tmp/oxbit-agents/context-fork";

/** A repository on `feature` with a commit, an uncommitted edit and an untracked file since `main`. */
async function open(page: Page) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-context-")));
  const root = path.join(directory, "workspace");
  await fs.mkdir(path.join(root, "src", "lib"), { recursive: true });
  await fs.writeFile(path.join(root, "hello.txt"), "hello\n");
  await fs.writeFile(path.join(root, "src", "main.ts"), "export const main = 1;\n");
  await fs.writeFile(path.join(root, "src", "lib", "util.ts"), "export const util = 1;\n");
  const author = { GIT_AUTHOR_NAME: "Oxbit Test", GIT_AUTHOR_EMAIL: "oxbit@example.test", GIT_COMMITTER_NAME: "Oxbit Test", GIT_COMMITTER_EMAIL: "oxbit@example.test" };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env: { ...process.env, ...author } }).toString().trim();
  git("init", "-q", "--initial-branch=main");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  await fs.writeFile(path.join(root, "src", "main.ts"), "export const main = 2;\n");
  git("commit", "-qam", "Add feature flag");
  await fs.writeFile(path.join(root, "hello.txt"), "hello from the branch\n");
  await fs.writeFile(path.join(root, "notes.md"), "untracked note\n");
  const runtime = await createRuntime({
    root, port: 0, dataDir: path.join(directory, "state"),
    settingsFile: path.join(directory, "settings.json"),
    projectsDir: path.join(directory, "projects"), pairingCode: "acp-context",
  });
  await page.goto(`http://127.0.0.1:${runtime.port}`);
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate((url) => (window as any).__oxbit.connectRuntime(url, "acp-context"), `http://127.0.0.1:${runtime.port}`);
  await page.waitForFunction(() => (window as any).__oxbit.runtime?.connected);
  await page.evaluate(async ({ command, args }) => {
    const z = (window as any).__oxbit;
    await z.runtime.trust(true);
    await z.kernel.extensions.activate("oxbit.agent-acp");
    z.kernel.services.get("agentACP").selection = { provider: "codex", command, args };
    z.workbench.set({ sidebarWidth: 420 });
    z.workbench.run("agentACP.open");
  }, { command: process.execPath, args: [fixture] });
  const panel = page.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)").first();
  const input = panel.getByRole("textbox", { name: "Message agent" });
  return {
    panel,
    input,
    log: panel.getByRole("log"),
    mentions: page.getByRole("listbox", { name: "Mention files and context" }),
    commit: git("rev-parse", "--short=7", "HEAD"),
    ready: () => expect(panel.locator(".acp-status")).toHaveText("Ready"),
    send: async (text: string) => {
      await input.fill(text);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
    },
    async close() {
      await page.goto("about:blank");
      await runtime.close();
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

test("@Branch diff, @Commit and @Folder attach and send their context", async ({ page }, info) => {
  const app = await open(page);
  const { panel, input, log, mentions } = app;
  try {
    await fs.mkdir(shots, { recursive: true });
    await input.fill("context-inspect @bra");
    await mentions.getByRole("option", { name: /Branch diff/ }).click();
    await expect(input).toHaveValue("context-inspect ");
    await expect(panel.getByRole("button", { name: "Remove attachment Branch diff: main...feature" })).toBeVisible();

    await input.pressSequentially("@flag");
    const commit = mentions.getByRole("option", { name: /Add feature flag/ });
    await expect(commit).toContainText(`${app.commit} · Oxbit Test`);
    await page.screenshot({ path: `${shots}/${info.project.name}-commit-option.png` });
    await commit.click();
    await expect(input).toHaveValue("context-inspect ");
    await expect(panel.getByRole("button", { name: `Remove attachment Commit ${app.commit}: Add feature flag` })).toBeVisible();

    await input.pressSequentially("@lib");
    await mentions.getByRole("option", { name: /src\/lib\/$/ }).click();
    await expect(input).toHaveValue("context-inspect @src/lib/ ");
    await expect(panel.getByRole("button", { name: "Remove attachment Folder: src/lib" })).toBeVisible();
    await page.screenshot({ path: `${shots}/${info.project.name}-attachments.png` });

    await app.send("context-inspect");
    await expect(log).toContainText("Branch diff: main...feature");
    await expect(log).toContainText("+hello from the branch");
    await expect(log).toContainText("+export const main = 2;");
    await expect(log).toContainText("+untracked note");
    await expect(log).toContainText(`Commit ${app.commit}: Add feature flag`);
    await expect(log).toContainText("Author: Oxbit Test");
    await expect(log).toContainText("--- src/lib/util.ts");
    await expect(log).toContainText("export const util = 1;");
    await app.ready();
  } finally {
    await app.close();
  }
});

test("Branch diff hides when the runtime lacks git.branchDiff", async ({ page }) => {
  const app = await open(page);
  try {
    await page.evaluate(() => {
      const runtime = (window as any).__oxbit.kernel.services.get("agentACP").options.runtime;
      const request = runtime.request.bind(runtime);
      runtime.request = (method: string, ...rest: unknown[]) => method === "git.branchDiff"
        ? Promise.reject(Object.assign(new Error("Unknown runtime method git.branchDiff"), { code: "METHOD_NOT_FOUND" }))
        : request(method, ...rest);
    });
    await app.input.fill("@");
    await expect(app.mentions.getByRole("option", { name: /Changes/ })).toBeVisible();
    await expect(app.mentions.getByRole("option", { name: /Branch diff/ })).toHaveCount(0);
    await app.input.fill("@flag");
    await expect(app.mentions.getByRole("option", { name: /Add feature flag/ })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("the in-app Oxbit agent hides Branch diff without a runtime workspace", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    z.kernel.services.register("agentModels", {
      async *stream() {},
      keys: { has: async () => true, save: async () => {}, remove: async () => {} },
    });
    await z.kernel.extensions.activate("oxbit.agent-acp");
    z.workbench.run("agentACP.open");
  });
  const panel = page.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)").first();
  await panel.getByRole("textbox", { name: "Message agent" }).fill("@");
  const mentions = page.getByRole("listbox", { name: "Mention files and context" });
  await expect(mentions.getByRole("option", { name: /Changes/ })).toBeVisible();
  await expect(mentions.getByRole("option", { name: /Branch diff/ })).toHaveCount(0);
});

test("Fork from here opens a new conversation with the earlier messages attached", async ({ page }, info) => {
  const app = await open(page);
  const { panel, input, log } = app;
  try {
    await app.send("remember the blue door");
    await expect(log).toContainText("Done.");
    await app.ready();
    await app.send("which door?");
    await expect(log.locator(".acp-user-text")).toHaveText(["remember the blue door", "which door?"]);
    await app.ready();
    const original = await page.evaluate(() => (window as any).__oxbit.kernel.services.get("agentACP").activeConversation.id);

    const message = log.locator("article.acp-message.user").nth(1);
    await message.hover();
    await message.getByRole("button", { name: "Message actions" }).click();
    const menu = page.getByRole("menu", { name: "Message actions" });
    await expect(menu.getByRole("menuitem", { name: "Restore files and fork" })).toBeVisible();
    const box = (await menu.getByRole("menuitem", { name: "Fork from here" }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({ path: `${shots}/${info.project.name}-fork-menu.png` });
    await menu.getByRole("menuitem", { name: "Fork from here" }).click();

    await expect(input).toHaveValue("which door?");
    await expect(log.locator(".acp-user-text")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Remove attachment Thread: remember the blue door" })).toBeVisible();
    await page.screenshot({ path: `${shots}/${info.project.name}-forked.png` });
    const saved = await page.evaluate((id) => {
      const agent = (window as any).__oxbit.kernel.services.get("agentACP");
      return { open: agent.activeConversation.id, messages: agent.history.entries.find((entry: any) => entry.id === id)?.activity
        .filter((item: any) => item.kind === "message" && item.message.role === "user").map((item: any) => item.message.text) };
    }, original);
    expect(saved.open).not.toBe(original);
    expect(saved.messages).toEqual(["remember the blue door", "which door?"]);

    await app.send("context-inspect");
    await expect(log).toContainText("User: remember the blue door");
    await expect(log).toContainText("Agent: Hello from ACP. Done.");
    await expect(log).not.toContainText("User: which door?");
    await app.ready();
  } finally {
    await app.close();
  }
});
