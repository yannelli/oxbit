/* global browser, $, describe, it */
import assert from "node:assert/strict";
import path from "node:path";
import * as fs from "node:fs/promises";
const project = path.join(process.env.OXBIT_NATIVE_FIXTURES, "Alpha project");
describe("Tasks in the native WebView", () => {
  it("saves a private task, runs it, edits lifecycle settings, and publishes a project config", async () => {
    await browser.waitUntil(() =>
      browser.execute(() => !!globalThis.__oxbitDesktop),
    );
    await browser.execute(async (project) => {
      await globalThis.__oxbitDesktop.native.open(project);
    }, project);
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          !!globalThis.__oxbit?.ready &&
          globalThis.__oxbit.workbench ===
            globalThis.__oxbitDesktop.manager.active?.session?.workbench,
      ),
    );
    await browser.execute(async () => {
      const app = globalThis.__oxbit;
      await app.runtime.trust(true);
      app.workbench.openPanel("tasks");
      app.workbench.set({ panelHeight: 450 });
      await app.kernel.services.get("tasks").refresh();
    });
    await $("button=New task").click();
    await $(".task-dialog").waitForExist();
    await browser.execute(() =>
      document
        .querySelector(".dialog")
        .getAnimations()
        .forEach((animation) => animation.finish()),
    );
    await $(".task-name").setValue("Native task");
    await $(".task-command").setValue("printf 'native task complete\\n'");
    await $("button=Save task").click();
    await browser.waitUntil(() =>
      browser.execute(() => !document.querySelector(".task-dialog")),
    );
    const catalog = await browser.execute(() =>
      globalThis.__oxbit.kernel.services.get("tasks").catalog(),
    );
    assert.match(
      catalog.privatePath,
      /\.oxbit\/projects\/[0-9a-f-]{36}\/tasks\.json$/,
    );
    assert.equal((await fs.readdir(project)).includes(".oxbit"), false);
    assert.equal(
      JSON.parse(await fs.readFile(catalog.privatePath, "utf8")).tasks[
        "Native task"
      ].command,
      "printf 'native task complete\\n'",
    );
    await $('[aria-label="Start Native task"]').click();
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document.querySelector(".tasks-detail .task-state")?.textContent ===
          "completed",
      ),
    );
    assert.match(await $(".task-log").getText(), /native task complete/);
    await $('[aria-label="Worktree lifecycle and environment"]').click();
    await $(".task-dialog").waitForExist();
    await browser.execute(() =>
      document
        .querySelector(".dialog")
        .getAnimations()
        .forEach((animation) => animation.finish()),
    );
    await $('[aria-label="preinit script"]').setValue("echo prepare");
    await $('[aria-label="teardown script"]').setValue("echo teardown");
    await $("button=Save lifecycle").click();
    await browser.waitUntil(() =>
      browser.execute(() => !document.querySelector(".task-dialog")),
    );
    const saved = JSON.parse(await fs.readFile(catalog.privatePath, "utf8"));
    assert.equal(saved.worktree.preinit, "echo prepare");
    assert.equal(saved.worktree.teardown, "echo teardown");
    await $(".tasks-footer button").click();
    await $('[role="dialog"]').waitForExist();
    await browser.execute(() =>
      document
        .querySelector(".dialog")
        .getAnimations()
        .forEach((animation) => animation.finish()),
    );
    await $("button=Save in project").click();
    await browser.waitUntil(
      async () =>
        !!(await fs
          .stat(path.join(project, ".oxbit/tasks.json"))
          .catch(() => undefined)),
    );
    assert.equal(
      JSON.parse(
        await fs.readFile(path.join(project, ".oxbit/tasks.json"), "utf8"),
      ).tasks["Native task"].command,
      "printf 'native task complete\\n'",
    );
    await fs.mkdir("evidence/tasks", { recursive: true });
    await browser.saveScreenshot(
      `evidence/tasks/native-${process.platform === "darwin" ? "macos" : "linux"}.png`,
    );
  });
});
