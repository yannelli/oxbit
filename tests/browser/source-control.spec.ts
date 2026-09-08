import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createRuntime } from "../../apps/runtime/src/runtime.js";
import { runCommand } from "../../apps/runtime/src/processes.js";

async function git(root: string, ...args: string[]) {
  const result = await runCommand("git", args, { cwd: root });
  if (result.exitCode) throw new Error(result.stderr + result.stdout);
  return result.stdout.trim();
}
async function fixture(page: Page) {
  page.setDefaultTimeout(15000);
  const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-scm-browser-")),
    ),
    root = path.join(directory, "workspace");
  await fs.mkdir(root);
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Oxbit Test");
  await git(root, "config", "user.email", "oxbit@example.test");
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  await fs.writeFile(path.join(root, "example.txt"), lines.join("\n") + "\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Initial project");
  const runtime = await createRuntime({
    root,
    port: 0,
    dataDir: path.join(directory, "state"),
    settingsFile: path.join(directory, "settings.json"),
    projectsDir: path.join(directory, "projects"),
    pairingCode: "scm-browser-fixture",
  });
  await page.goto(`http://127.0.0.1:${runtime.port}`);
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async (url) => {
    await (window as any).__oxbit.connectRuntime(url, "scm-browser-fixture");
    await (window as any).__oxbit.runtime.trust(true);
  }, `http://127.0.0.1:${runtime.port}`);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    z.workbench.openPanel("scm");
    z.workbench.set({ sidebarWidth: 360, panel: false, notifications: [] });
    await z.kernel.services.get("git").refresh();
  });
  await expect(page.getByRole("combobox", { name: "Git branch" })).toHaveText(
    "main",
  );
  await fs.mkdir("evidence/source-control", { recursive: true });
  return {
    root,
    directory,
    lines,
    close: async () => {
      await page.close({ runBeforeUnload: false });
      await runtime.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
async function refresh(page: Page) {
  await page.evaluate(() =>
    (window as any).__oxbit.kernel.services.get("git").refresh(),
  );
}
async function prompt(page: Page, text: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(text);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
}
async function tab(page: Page, name: string) {
  await page.getByRole("tab", { name, exact: true }).click();
}

test("source control supports hunks, commits, branch creation, publishing, history, and stashes", async ({
  page,
}) => {
  const f = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    f.lines[1] = "first edited section";
    f.lines[25] = "second edited section";
    await fs.writeFile(
      path.join(f.root, "example.txt"),
      f.lines.join("\n") + "\n",
    );
    await refresh(page);
    await page
      .locator(".scm-panel")
      .getByRole("button", { name: "example.txt", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review hunks", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Stage hunk 2", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "evidence/source-control/hunks-dark.png" });
    await page
      .getByRole("button", { name: "Stage hunk 1", exact: true })
      .click();
    await expect
      .poll(() => git(f.root, "show", ":example.txt"))
      .toContain("first edited section");
    expect(await git(f.root, "show", ":example.txt")).not.toContain(
      "second edited section",
    );
    await expect(
      page.getByRole("button", { name: "Stage hunk 2", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Unstage example.txt", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Stage All Changes", exact: true })
      .click();
    const message = page.getByRole("textbox", { name: "Commit message" });
    await message.fill("Improve two sections");
    await expect(
      page.getByRole("button", { name: "Commit staged changes", exact: true }),
    ).toBeEnabled();
    await message.press("Control+Enter");
    await expect
      .poll(() => git(f.root, "log", "-1", "--format=%s"))
      .toBe("Improve two sections");
    await expect(message).toHaveValue("");
    await tab(page, "History");
    await page.getByRole("button", { name: /Improve two sections/ }).click();
    await expect(page.locator(".scm-commit-details h2")).toHaveText(
      "Improve two sections",
    );
    await expect(page.locator(".scm-commit-details .scm-patch")).toContainText(
      "+first edited section",
    );
    await page.screenshot({ path: "evidence/source-control/history-dark.png" });
    await page
      .getByRole("textbox", { name: "Search commit messages" })
      .fill("Initial");
    await page
      .locator(".scm-filter-form")
      .getByRole("button", { name: "Search", exact: true })
      .click();
    await expect(page.locator(".scm-history-row")).toHaveCount(1);
    await expect(page.locator(".scm-history-row")).toContainText(
      "Initial project",
    );
    await tab(page, "Branches");
    await page
      .getByRole("button", { name: "Create branch", exact: true })
      .click();
    await prompt(page, "feature/source-control");
    await expect(page.getByRole("combobox", { name: "Git branch" })).toHaveText(
      "feature/source-control",
    );
    const remote = path.join(f.directory, "remote.git");
    await git(f.directory, "init", "--bare", "--initial-branch=main", remote);
    await page.getByRole("button", { name: "Add remote", exact: true }).click();
    await prompt(page, "origin");
    await prompt(page, pathToFileURL(remote).href);
    await page
      .getByRole("button", { name: "Publish current branch", exact: true })
      .click();
    await expect(page.locator(".scm-tracking")).toContainText(
      "origin/feature/source-control",
    );
    expect(
      await git(remote, "rev-parse", "refs/heads/feature/source-control"),
    ).toBe(await git(f.root, "rev-parse", "HEAD"));
    await page.screenshot({
      path: "evidence/source-control/branches-dark.png",
    });
    await fs.writeFile(path.join(f.root, "later.txt"), "save this for later\n");
    await refresh(page);
    await tab(page, "Stashes");
    await page
      .getByRole("textbox", { name: "Stash message" })
      .fill("Work in progress");
    await page
      .getByRole("button", { name: "Stash changes", exact: true })
      .click();
    await expect(page.locator(".scm-stash-open")).toContainText(
      "Work in progress",
    );
    await expect.poll(() => git(f.root, "status", "--porcelain")).toBe("");
    await page.locator(".scm-stash-open").click();
    await expect(page.locator(".scm-commit-details .scm-patch")).toContainText(
      "+save this for later",
    );
    await page.screenshot({ path: "evidence/source-control/stash-dark.png" });
    await page.getByRole("button", { name: "Pop", exact: true }).click();
    await expect(
      page.getByText("No stashes yet", { exact: true }),
    ).toBeVisible();
    expect(await fs.readFile(path.join(f.root, "later.txt"), "utf8")).toBe(
      "save this for later\n",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() =>
      (window as any).__oxbit.workbench.openPanel("scm"),
    );
    await tab(page, "Changes");
    await page.getByRole("textbox", { name: "Commit message" }).click();
    await expect(
      page.getByRole("textbox", { name: "Commit message" }),
    ).toBeFocused();
    expect(
      await page
        .locator(".scm-panel")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: "evidence/source-control/phone-dark.png" });
    await page.getByRole("tab", { name: "Changes", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "History", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.evaluate(() =>
      (window as any).__oxbit.kernel.configuration.set(
        "workbench.colorTheme",
        "Paper (light)",
      ),
    );
    await expect(page.locator(".scm-history-row")).toHaveCount(2);
    await page.screenshot({ path: "evidence/source-control/phone-light.png" });
    expect(errors).toEqual([]);
  } catch (error) {
    await page
      .screenshot({ path: "/tmp/oxbit-scm-failure.png" })
      .catch(() => {});
    await fs.writeFile(
      "/tmp/oxbit-scm-failure.txt",
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    throw error;
  } finally {
    await f.close();
  }
});

test("source control protects dirty buffers and guides merge resolution and recovery", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await git(f.root, "switch", "-c", "other");
    await fs.writeFile(path.join(f.root, "example.txt"), "incoming\n");
    await git(f.root, "commit", "-am", "Incoming change");
    await git(f.root, "switch", "main");
    await fs.writeFile(path.join(f.root, "example.txt"), "current\n");
    await git(f.root, "commit", "-am", "Current change");
    await refresh(page);
    await page.evaluate(async () => {
      const z = (window as any).__oxbit;
      await z.workbench.openFile("example.txt");
      z.documents.get("example.txt").replace("unsaved work\n");
    });
    await page.getByRole("combobox", { name: "Git branch" }).click();
    await page.getByRole("option", { name: "other", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "Unsaved editor changes",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    expect(await git(f.root, "branch", "--show-current")).toBe("main");
    expect(
      await page.evaluate(() =>
        (window as any).__oxbit.documents.get("example.txt").text.toString(),
      ),
    ).toBe("unsaved work\n");
    await page.evaluate(() =>
      (window as any).__oxbit.documents.get("example.txt").replace("current\n"),
    );
    await tab(page, "Branches");
    const branch = page
      .locator(".scm-branch-card")
      .filter({ has: page.locator("strong", { hasText: /^other$/ }) });
    await branch
      .getByRole("button", { name: "Merge into current", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Merge", exact: true })
      .click();
    await expect(page.locator(".scm-operation")).toContainText(
      "merge in progress",
    );
    await page.getByRole("button", { name: "Abort", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Abort", exact: true })
      .click();
    await expect(page.locator(".scm-operation")).toHaveCount(0);
    expect(await fs.readFile(path.join(f.root, "example.txt"), "utf8")).toBe(
      "current\n",
    );
    await branch
      .getByRole("button", { name: "Merge into current", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Merge", exact: true })
      .click();
    await expect(page.locator(".scm-operation")).toContainText(
      "merge in progress",
    );
    await tab(page, "Changes");
    await expect(
      page.getByRole("region", { name: "Merge changes", exact: true }),
    ).toBeVisible();
    await page
      .locator(".scm-panel")
      .getByRole("button", { name: "example.txt", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Accept both", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save and Stage", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: "evidence/source-control/conflict-resolved.png",
    });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.locator(".scm-operation")).toHaveCount(0);
    expect(await fs.readFile(path.join(f.root, "example.txt"), "utf8")).toBe(
      "current\nincoming\n",
    );
    expect(
      (await git(f.root, "show", "-s", "--format=%P", "HEAD")).split(" "),
    ).toHaveLength(2);
    await page.evaluate(() => (window as any).__oxbit.runtime.trust(false));
    const code = await page.evaluate(async () => {
      try {
        await (window as any).__oxbit.runtime.request("git.stashSave", {
          message: "forbidden",
        });
        return "unexpected";
      } catch (error: any) {
        return error.code;
      }
    });
    expect(code).toBe("UNTRUSTED");
  } catch (error) {
    await page
      .screenshot({ path: "/tmp/oxbit-scm-failure.png" })
      .catch(() => {});
    await fs.writeFile(
      "/tmp/oxbit-scm-failure.txt",
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    throw error;
  } finally {
    await f.close();
  }
});
