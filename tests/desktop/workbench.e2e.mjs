/* global browser, $, describe, it */
import assert from "node:assert/strict";
import path from "node:path";
import * as fs from "node:fs/promises";
const fixture = process.env.OXBIT_NATIVE_FIXTURES;
const alpha = path.join(fixture, "Alpha project");
const beta = path.join(fixture, "Beta 项目");
const ready = () =>
  browser.waitUntil(
    () =>
      browser.execute(
        () =>
          !!globalThis.__oxbit?.ready &&
          globalThis.__oxbit.workbench ===
            globalThis.__oxbitDesktop.manager.active?.session?.workbench,
      ),
    { timeout: 40000 },
  );
const activeName = () =>
  browser.execute(() =>
    globalThis.__oxbit?.workbench ===
    globalThis.__oxbitDesktop.manager.active?.session?.workbench
      ? globalThis.__oxbitDesktop.manager.active?.project.name
      : undefined,
  );

describe("Oxbit native workbench", () => {
  it("opens a real folder in a local WebView without trusting its tools", async () => {
    await browser.waitUntil(
      () => browser.execute(() => !!globalThis.__oxbitDesktop),
      { timeout: 30000 },
    );
    assert.match(await browser.getUrl(), /^tauri:\/\/localhost/);
    await browser.execute(async (p) => {
      await globalThis.__oxbitDesktop.native.open(p);
    }, alpha);
    await ready();
    assert.equal(await activeName(), "Alpha project");
    assert.equal(
      await browser.execute(() => globalThis.__oxbit.runtime.session.trusted),
      false,
    );
    assert.equal(await $(".cm-editor").isDisplayed(), true);
    assert.equal(await browser.execute(() => sessionStorage.length), 0);
    const denied = await browser.execute(async () => {
      try {
        await globalThis.__oxbitDesktop.native.open("/etc");
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(
      denied,
      true,
      "Frontend code must not grant itself a new filesystem root",
    );
  });
  it("retains dirty documents across project switches and duplicate opens", async () => {
    await browser.execute(() =>
      globalThis.__oxbit.documents
        .get("hello.ts")
        .replace("export const retained = 42;\n"),
    );
    await browser.execute(async (p) => {
      await globalThis.__oxbitDesktop.native.open(p);
    }, beta);
    await browser.waitUntil(async () => (await activeName()) === "Beta 项目");
    await browser.execute(async (p) => {
      await globalThis.__oxbitDesktop.native.open(p);
    }, alpha);
    await browser.waitUntil(
      async () => (await activeName()) === "Alpha project",
    );
    assert.equal(
      await browser.execute(() =>
        globalThis.__oxbit.documents.get("hello.ts").text.toString(),
      ),
      "export const retained = 42;\n",
    );
    assert.equal(
      await browser.execute(
        () => globalThis.__oxbitDesktop.manager.snapshot().projects.length,
      ),
      2,
    );
    assert.equal(
      await browser.execute(
        () => document.querySelectorAll(".workbench").length,
      ),
      1,
    );
  });
  it("cancels a close without losing drafts, and saves through the close flow", async () => {
    await browser.execute(async () => {
      const api = globalThis.__oxbitDesktop;
      await api.native.close("project", api.manager.active.project.key);
    });
    await $("button=Cancel").waitForDisplayed();
    await $("button=Cancel").click();
    await browser.waitUntil(() =>
      browser.execute(() => !document.querySelector(".dialog")),
    );
    assert.equal(
      await browser.execute(
        () => globalThis.__oxbit.documents.get("hello.ts").dirty,
      ),
      true,
    );
    await browser.execute(async () => {
      const api = globalThis.__oxbitDesktop;
      await api.native.close("project", api.manager.active.project.key);
    });
    await $("button=Save All").waitForDisplayed();
    await $("button=Save All").click();
    await browser.waitUntil(async () => (await activeName()) === "Beta 项目");
    await browser.execute(async (p) => {
      await globalThis.__oxbitDesktop.native.open(p);
    }, alpha);
    await browser.waitUntil(
      async () => (await activeName()) === "Alpha project",
    );
    assert.equal(
      await browser.execute(
        async () => (await globalThis.__oxbit.filesystem.read("hello.ts")).text,
      ),
      "export const retained = 42;\n",
    );
  });
  it("routes a nested file into its existing project and consumes the open event once", async () => {
    await browser.execute(
      async (p) => {
        await globalThis.__oxbitDesktop.native.open(p);
      },
      path.join(alpha, "src/nested.ts"),
    );
    await browser.waitUntil(() =>
      browser.execute(
        () => globalThis.__oxbit.workbench.activePath() === "src/nested.ts",
      ),
    );
    assert.equal(await activeName(), "Alpha project");
    assert.equal(
      await browser.execute(
        () => globalThis.__oxbitDesktop.manager.snapshot().projects.length,
      ),
      2,
    );
    await browser.execute(async () => {
      await globalThis.__oxbit.workbench.openFile("hello.ts", {
        preview: false,
      });
      await globalThis.__oxbitDesktop.manager.refresh();
    });
    assert.equal(
      await browser.execute(() => globalThis.__oxbit.workbench.activePath()),
      "hello.ts",
    );
  });
  it("discards a project draft only after acceptance and does not recover it on reopen", async () => {
    await browser.execute(async () => {
      globalThis.__oxbit.documents
        .get("hello.ts")
        .replace("discard this draft");
      await globalThis.__oxbitDesktop.native.close(
        "project",
        globalThis.__oxbitDesktop.manager.active.project.key,
      );
    });
    await $("button=Discard").waitForDisplayed();
    await $("button=Discard").click();
    await browser.waitUntil(async () => (await activeName()) === "Beta 项目");
    await browser.execute(async (p) => {
      await globalThis.__oxbitDesktop.native.open(p);
    }, alpha);
    await browser.waitUntil(
      async () => (await activeName()) === "Alpha project",
    );
    assert.equal(
      await browser.execute(() =>
        globalThis.__oxbit.documents.get("hello.ts").text.toString(),
      ),
      "export const retained = 42;\n",
    );
    assert.equal(
      await browser.execute(
        () => globalThis.__oxbit.documents.get("hello.ts").dirty,
      ),
      false,
    );
  });
  it("runs a real PTY and search only after explicit trust and uses native clipboard", async () => {
    await browser.execute(async () => {
      await globalThis.__oxbit.runtime.trust(true);
      await globalThis.__oxbit.workbench.run("terminal.new");
    });
    await browser.waitUntil(() =>
      browser.execute(() => !!document.querySelector(".xterm")),
    );
    const result = await browser.execute(async () => {
      const { runtime } = globalThis.__oxbit;
      const list = await runtime.request("terminal.list");
      await runtime.request("terminal.input", {
        id: list[0].id,
        data: "printf 'NATIVE_PTY_SUCCESS'\r",
      });
      const search = await runtime.request("search.query", {
        query: "retained",
      });
      await globalThis.__oxbitDesktop.native.clipboard(
        "Oxbit native clipboard café",
      );
      return { search, clipboard: await navigator.clipboard.readText() };
    });
    assert.match(JSON.stringify(result.search), /hello.ts/);
    assert.equal(result.clipboard, "Oxbit native clipboard café");
  });
  it("completes TypeScript, cancels a real task, and stages a Git file in the native host", async () => {
    const completion = await browser.execute(async () => {
      const z = globalThis.__oxbit;
      const text = 'const greeting = "hello";\ngreeting.';
      await z.filesystem.write("completion.ts", text, {
        expectedRevision: null,
      });
      await z.runtime.request("lsp.start");
      const root = globalThis.__oxbitDesktop.manager.active.project.path;
      const uri = new URL(
        "file://" +
          root.split("/").map(encodeURIComponent).join("/") +
          "/completion.ts",
      ).href;
      await z.runtime.request("lsp.notify", {
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "typescript", version: 1, text },
        },
      });
      const result = await z.runtime.request("lsp.request", {
        method: "textDocument/completion",
        params: { textDocument: { uri }, position: { line: 1, character: 9 } },
      });
      const tasks = z.kernel.services.get("tasks");
      const id = await tasks.run("sleep 60");
      await tasks.cancel(id);
      await z.kernel.services.get("git").stage("completion.ts");
      return result;
    });
    assert.match(JSON.stringify(completion), /toUpperCase/);
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          [
            ...globalThis.__oxbit.kernel.services.get("tasks").tasks.values(),
          ].at(-1)?.state === "cancelled",
      ),
    );
    const diff = await browser.execute(() =>
      globalThis.__oxbit.runtime.request("git.diff", {
        path: "completion.ts",
        staged: true,
      }),
    );
    assert.match(diff.after, /greeting/);
  });
  it("preserves a dirty draft when an external disk edit causes a conflict", async () => {
    await browser.execute(async () => {
      const z = globalThis.__oxbit;
      await z.filesystem.write(
        "native-conflict.ts",
        "export const original = 1;\n",
        { expectedRevision: null },
      );
      await z.workbench.openFile("native-conflict.ts", { preview: false });
      z.documents
        .get("native-conflict.ts")
        .replace("export const draft = 2;\n");
      await z.documents.persist();
    });
    await fs.writeFile(
      path.join(alpha, "native-conflict.ts"),
      "export const external = 3;\n",
    );
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          globalThis.__oxbit.documents.get("native-conflict.ts").state ===
          "conflict",
      ),
    );
    const result = await browser.execute(async () => {
      const z = globalThis.__oxbit;
      let rejected = false;
      try {
        await z.documents.save("native-conflict.ts");
      } catch {
        rejected = true;
      }
      return {
        rejected,
        text: z.documents.get("native-conflict.ts").text.toString(),
      };
    });
    assert.equal(result.rejected, true);
    assert.match(result.text, /draft = 2/);
    assert.match(
      await fs.readFile(path.join(alpha, "native-conflict.ts"), "utf8"),
      /external = 3/,
    );
    await browser.execute(async () => {
      const z = globalThis.__oxbit;
      await z.documents.reload("native-conflict.ts");
      await z.workbench.openFile("hello.ts", { preview: false });
    });
  });
  it("loads an SDK extension through the application protocol and cleans its contributions", async () => {
    const result = await browser.execute(async () => {
      const z = globalThis.__oxbit;
      const existing = z.kernel.extensions
        .list()
        .find((e) => e.manifest.name === "Bundle Inspector");
      if (existing) await z.kernel.extensions.remove(existing.manifest.id);
      const sdk = await import(location.origin + "/sdk/index.js");
      const id = await z.kernel.extensions.load(
        location.origin + "/extensions/bundle-inspector.js",
      );
      await z.kernel.commands.execute("bundle.analyze");
      const activated = z.kernel.contributions
        .list()
        .some((c) => c.id === "bundle");
      await z.kernel.extensions.disable(id);
      const removed = !z.kernel.contributions
        .list()
        .some((c) => c.id === "bundle" || c.id === "bundle.report");
      await z.kernel.extensions.activate(id);
      return { sdk: sdk.SDK_VERSION, activated, removed };
    });
    assert.deepEqual(result, { sdk: "1.0.0", activated: true, removed: true });
  });
  it("restarts a crashed runtime with the same drafts and ended tools", async () => {
    const before = await browser.execute(() => ({
      key: globalThis.__oxbitDesktop.manager.active.project.key,
      identity: globalThis.__oxbit.filesystem.id,
    }));
    await browser.execute(async () => {
      globalThis.__oxbit.documents
        .get("hello.ts")
        .replace("export const recovered = true;\n");
      await globalThis.__TAURI__.core.invoke("desktop_test_crash", {
        key: globalThis.__oxbitDesktop.manager.active.project.key,
      });
    });
    await $("button=Restart Runtime").waitForDisplayed();
    assert.equal(
      await browser.execute(
        () => globalThis.__oxbit.documents.get("hello.ts").dirty,
      ),
      true,
    );
    await $("button=Restart Runtime").click();
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!globalThis.__oxbit.runtime.connected &&
            !globalThis.__oxbitDesktop.manager.active.failed,
        ),
      { timeout: 30000 },
    );
    await ready();
    assert.equal(
      await browser.execute(() => globalThis.__oxbit.filesystem.id),
      before.identity,
    );
    assert.equal(
      await browser.execute(() =>
        globalThis.__oxbit.documents.get("hello.ts").text.toString(),
      ),
      "export const recovered = true;\n",
    );
    assert.deepEqual(
      await browser.execute(
        async () => await globalThis.__oxbit.runtime.request("terminal.list"),
      ),
      [],
    );
  });
  it("honors new-window settings, shared settings, and duplicate-project focusing", async () => {
    const main = await browser.getWindowHandle();
    await browser.execute(async () => {
      await globalThis.__oxbitDesktop.native.settings([
        { path: ["user", "desktop.projects.openBehavior"], value: "newWindow" },
      ]);
    });
    await browser.execute(
      async (p) => {
        await globalThis.__oxbitDesktop.native.open(p);
      },
      path.join(fixture, "Gamma project"),
    );
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 2,
    );
    const other = (await browser.getWindowHandles()).find(
      (handle) => handle !== main,
    );
    await browser.switchToWindow(other);
    await ready();
    assert.equal(await activeName(), "Gamma project");
    await browser.execute(async () => {
      await globalThis.__oxbitDesktop.native.settings([
        { path: ["user", "editor.fontSize"], value: 17 },
      ]);
    });
    await browser.execute(async (p) => {
      await globalThis.__oxbitDesktop.native.open(p);
    }, alpha);
    assert.equal((await browser.getWindowHandles()).length, 2);
    await browser.switchToWindow(main);
    await ready();
    assert.equal(await activeName(), "Alpha project");
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          globalThis.__oxbit.kernel.configuration.get("editor.fontSize") === 17,
      ),
    );
    await browser.execute(async () => {
      await globalThis.__oxbitDesktop.native.settings([
        {
          path: ["user", "desktop.projects.openBehavior"],
          value: "currentWindow",
        },
      ]);
    });
  });
  it("moves a project with its dirty draft and running runtime, then denies its old window", async () => {
    const main = await browser.getWindowHandle();
    const handles = await browser.getWindowHandles();
    const before = await browser.execute(async () => {
      const manager = globalThis.__oxbitDesktop.manager;
      const entry = manager
        .snapshot()
        .projects.find((p) => p.project.name === "Beta 项目");
      entry.session.documents
        .get("hello.ts")
        .replace("export const moved = 7;\n");
      const connection = await globalThis.__oxbitDesktop.native.connection(
        entry.project.key,
      );
      await manager.move(entry.project.key);
      return { key: entry.project.key, url: connection.url };
    });
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 3,
    );
    const denied = await browser.execute(async (key) => {
      try {
        await globalThis.__oxbitDesktop.native.connection(key);
        return false;
      } catch {
        return true;
      }
    }, before.key);
    assert.equal(denied, true);
    const moved = (await browser.getWindowHandles()).find(
      (handle) => !handles.includes(handle),
    );
    await browser.switchToWindow(moved);
    await ready();
    assert.equal(await activeName(), "Beta 项目");
    assert.equal(
      await browser.execute(() =>
        globalThis.__oxbit.documents.get("hello.ts").text.toString(),
      ),
      "export const moved = 7;\n",
    );
    assert.equal(
      await browser.execute(() => globalThis.__oxbit.runtime.url),
      before.url,
    );
    await browser.switchToWindow(main);
  });
  it("ignores a delayed prepare result after another window cancels quit", async () => {
    const main = await browser.getWindowHandle();
    await browser.execute(async () => {
      const runtime = globalThis.__oxbit.runtime;
      const original = runtime.request.bind(runtime);
      runtime.request = (method, ...args) =>
        method === "terminal.list"
          ? new Promise((resolve, reject) => {
              globalThis.__releaseClosePreparation = async () => {
                runtime.request = original;
                try {
                  resolve(await original(method, ...args));
                } catch (error) {
                  reject(error);
                }
              };
            })
          : original(method, ...args);
      await globalThis.__oxbitDesktop.native.close("quit");
    });
    await browser.waitUntil(() =>
      browser.execute(() => !!globalThis.__releaseClosePreparation),
    );
    let other;
    for (const handle of await browser.getWindowHandles()) {
      if (handle === main) continue;
      await browser.switchToWindow(handle);
      if ((await activeName()) === "Beta 项目") {
        other = handle;
        break;
      }
    }
    assert(other);
    await $("button=Cancel").waitForDisplayed();
    await $("button=Cancel").click();
    await browser.switchToWindow(main);
    await browser.waitUntil(() =>
      browser.execute(() => !globalThis.__oxbitDesktop.manager.isClosing),
    );
    await browser.execute(async () => {
      await globalThis.__releaseClosePreparation();
      delete globalThis.__releaseClosePreparation;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          !document.querySelector(".dialog") &&
          !globalThis.__oxbitDesktop.manager.isClosing,
      ),
    );
    assert.equal(
      await browser.execute(
        () => globalThis.__oxbit.documents.get("hello.ts").dirty,
      ),
      true,
    );
  });
  it("cancels application quit across windows without discarding their drafts", async () => {
    await browser.execute(async () => {
      await globalThis.__oxbitDesktop.native.close("quit");
    });
    await $("button=Cancel").waitForDisplayed();
    await $("button=Cancel").click();
    await browser.waitUntil(() =>
      browser.execute(() => !document.querySelector(".dialog")),
    );
    assert.equal((await browser.getWindowHandles()).length, 3);
    assert.equal(
      await browser.execute(
        () => globalThis.__oxbit.documents.get("hello.ts").dirty,
      ),
      true,
    );
  });
});
