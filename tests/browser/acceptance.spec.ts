import { test, expect, type Page } from "@playwright/test";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createRuntime } from "../../apps/runtime/src/runtime";
const ready = async (page: Page) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__zapp?.ready === true);
  await expect(page.locator(".cm-editor").first()).toBeVisible();
};
const runtime = async (page: Page) => {
  await ready(page);
  await page.evaluate(async () => {
    await (window as any).__zapp.connectRuntime(
      location.origin,
      "zapp-acceptance-2026",
    );
    await (window as any).__zapp.runtime.trust(true);
  });
  await page.waitForFunction(
    () =>
      (window as any).__zapp?.ready === true &&
      (window as any).__zapp.runtime?.connected,
  );
};
const open = async (page: Page, path: string) => {
  await page.evaluate(async (path) => {
    await (window as any).__zapp.workbench.openFile(path, { preview: false });
  }, path);
  await page.waitForFunction(
    (path) =>
      (window as any).__zapp.workbench.activePath() === path &&
      !!(window as any).__zapp.workbench.activeEditor(),
    path,
  );
};
const text = async (page: Page, path: string) =>
  page.evaluate(
    (path) => (window as any).__zapp.documents.get(path)?.text.toString(),
    path,
  );

test("browser workspace edits, saves, splits and recovers Unicode drafts and view state", async ({
  page,
}) => {
  await ready(page);
  await open(page, "README.md");
  await page.evaluate(() => {
    const z = (window as any).__zapp;
    z.documents.get("README.md").replace("# Browser recovery\n漢字 🐱\n");
    z.workbench.split("row");
  });
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    await z.documents.persist();
    await z.workbench.persist();
  });
  await page.reload();
  await page.waitForFunction(() => (window as any).__zapp?.ready === true);
  expect(await text(page, "README.md")).toContain("漢字 🐱");
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  await page.keyboard.press("Control+s");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__zapp.documents.get("README.md").dirty,
      ),
    )
    .toBe(false);
  await page.reload();
  await page.waitForFunction(() => (window as any).__zapp?.ready === true);
  expect(await text(page, "README.md")).toContain("漢字 🐱");
});

test("localized settings persist and fit the phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    z.kernel.configuration.set("workbench.locale", "de");
    await z.kernel.commands.execute("settings.open");
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByPlaceholder("Einstellungen suchen")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await page.waitForFunction(() => (window as any).__zapp?.ready === true);
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    z.kernel.configuration.set("workbench.locale", "en");
    await z.kernel.commands.execute("settings.open");
  });
  await expect(page.getByPlaceholder("Search settings")).toBeVisible();
});

test("the printed pairing link opens the runtime workspace on first launch", async ({
  page,
}) => {
  const { root } = JSON.parse(
    await readFile("evidence/e2e-workspace.json", "utf8"),
  );
  await page.goto("/#pair=zapp-acceptance-2026");
  await page.waitForFunction(() => (window as any).__zapp?.ready === true);
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  expect(
    await page.evaluate(() => ({
      connected: !!(window as any).__zapp.runtime?.connected,
      filesystem: (window as any).__zapp.filesystem.id,
      projectName: (window as any).__zapp.workbench.state.projectName,
      hash: location.hash,
    })),
  ).toEqual({
    connected: true,
    filesystem: expect.stringContaining("runtime:"),
    projectName: path.basename(root),
    hash: "",
  });
  expect(
    await page.evaluate(async () =>
      (await (window as any).__zapp.filesystem.list()).map(
        (entry: { path: string }) => entry.path,
      ),
    ),
  ).toContain("acceptance.ts");
});

test("the zapp command opens the named file in the runtime workspace", async ({
  page,
}) => {
  await page.goto("/#pair=zapp-acceptance-2026&open=acceptance.ts");
  await page.waitForFunction(() => (window as any).__zapp?.ready === true);
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  expect(
    await page.evaluate(() => ({
      connected: !!(window as any).__zapp.runtime?.connected,
      activePath: (window as any).__zapp.workbench.activePath(),
      hash: location.hash,
    })),
  ).toEqual({ connected: true, activePath: "acceptance.ts", hash: "" });
  expect(await text(page, "acceptance.ts")).toContain("export const greeting");
});

test("runtime filesystem, revision checked save, refresh and failed save recovery", async ({
  page,
}) => {
  await runtime(page);
  await open(page, "acceptance.ts");
  await page.evaluate(() => {
    const z = (window as any).__zapp;
    z.documents
      .get("acceptance.ts")
      .replace('export const accepted = "runtime saved";\n');
  });
  await page.keyboard.press("Control+s");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__zapp.documents.get("acceptance.ts").dirty,
      ),
    )
    .toBe(false);
  expect(
    await page.evaluate(
      async () =>
        (
          await (window as any).__zapp.runtime.request("fs.read", {
            path: "acceptance.ts",
          })
        ).text,
    ),
  ).toContain("runtime saved");
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    z.documents
      .get("acceptance.ts")
      .replace('export const accepted = "recovery draft";\n');
    await z.documents.persist();
    z.runtime.disconnect();
  });
  const failed = await page.evaluate(async () => {
    try {
      await (window as any).__zapp.documents.save("acceptance.ts");
      return false;
    } catch {
      return true;
    }
  });
  expect(failed).toBe(true);
  expect(await text(page, "acceptance.ts")).toContain("recovery draft");
  await page.evaluate(async () => {
    await (window as any).__zapp.runtime.connect();
    await (window as any).__zapp.kernel.services.get("collaboration").resync();
    await (window as any).__zapp.documents.save("acceptance.ts");
  });
  expect(
    await page.evaluate(
      async () =>
        (
          await (window as any).__zapp.runtime.request("fs.read", {
            path: "acceptance.ts",
          })
        ).text,
    ),
  ).toContain("recovery draft");
});

test("real language responses, diagnostics, rename edits and supported code action", async ({
  page,
}) => {
  await runtime(page);
  await open(page, "rename.ts");
  const result = await page.evaluate(async () => {
    const z = (window as any).__zapp;
    const language = z.kernel.services.get("language");
    await language.start();
    const doc = z.documents.get("rename.ts");
    const definitions = await language.at(
      "textDocument/definition",
      "rename.ts",
      doc.text.toString().lastIndexOf("beforeName") + 3,
    );
    const completion = await language.at(
      "textDocument/completion",
      "rename.ts",
      doc.text.toString().indexOf("log") + 1,
    );
    const versions = await language.snapshots();
    const edits = await language.at(
      "textDocument/rename",
      "rename.ts",
      doc.text.toString().indexOf("beforeName") + 3,
      { newName: "afterName" },
    );
    await language.applyWorkspaceEdit(edits, versions);
    await z.kernel.services.get("collaboration").flush();
    const actionVersions = await language.snapshots();
    const actions = await language.request("textDocument/codeAction", {
      textDocument: { uri: language.uri("rename.ts") },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      context: { diagnostics: [], only: ["source.removeUnusedImports.ts"] },
    });
    if (actions[0]?.edit)
      await language.applyWorkspaceEdit(actions[0].edit, actionVersions);
    return {
      definitions,
      completion: completion.items ?? completion,
      actions,
      text: doc.text.toString(),
    };
  });
  expect(result.definitions.length).toBeGreaterThan(0);
  expect(result.completion.some((i: any) => i.label === "log")).toBe(true);
  expect(result.text).toContain("afterName");
  expect(result.text).not.toContain("beforeName");
  expect(result.text).not.toContain("import");
  expect(result.actions.length).toBeGreaterThan(0);
  await open(page, "diagnostics.ts");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).__zapp.kernel.services
              .get("language")
              .diagnostics.get("diagnostics.ts") ?? [],
        ),
      { timeout: 30000 },
    )
    .toEqual(expect.arrayContaining([expect.objectContaining({ code: 2322 })]));
  await page.evaluate(async () => {
    await (window as any).__zapp.kernel.services.get("language").restart();
  });
  expect(await text(page, "rename.ts")).toContain("afterName");
});

test("workspace search previews replacements against unsaved versions", async ({
  page,
}) => {
  await runtime(page);
  const result = await page.evaluate(async () => {
    const z = (window as any).__zapp;
    const doc = await z.documents.open("search-a.txt");
    doc.replace("alpha unsaved alpha\n");
    const service = z.kernel.services.get("search"),
      options = { query: "alpha", include: "search-*.txt", wholeWord: true };
    const matches = await service.search(options);
    const preview = await service.preview(matches, options, "omega");
    const applied = await service.apply(preview);
    return {
      matches,
      applied,
      a: doc.text.toString(),
      b: z.documents.get("search-b.txt").text.toString(),
      dirty: doc.dirty,
    };
  });
  expect(result.matches).toHaveLength(3);
  expect(result.applied.failures).toEqual([]);
  expect(result.a).toBe("omega unsaved omega\n");
  expect(result.b).toBe("omega gamma\n");
  expect(result.dirty).toBe(true);
});

test("real terminal, resize, task status and cancellation", async ({
  page,
}) => {
  await runtime(page);
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    const s = await z.kernel.services.get("terminal").create();
    (window as any).__terminalId = s.id;
    await z.runtime.request("terminal.input", {
      id: s.id,
      data: "printf 'ZAPP_TERMINAL_OK\\n'\r",
    });
    await z.runtime.request("terminal.resize", {
      id: s.id,
      cols: 91,
      rows: 27,
    });
    await z.kernel.services
      .get("tasks")
      .run("printf 'acceptance.ts:1:1 ZAPP_TASK_OK\\n'");
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__zapp.kernel.services
            .get("tasks")
            .tasks.values()
            .next().value?.output ?? "",
      ),
    )
    .toContain("ZAPP_TASK_OK");
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    const id = await z.kernel.services
      .get("tasks")
      .run('node -e "setInterval(()=>{},1000)"');
    await z.kernel.services.get("tasks").cancel(id);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [
            ...(window as any).__zapp.kernel.services
              .get("tasks")
              .tasks.values(),
          ].at(-1)?.state,
      ),
    )
    .toBe("cancelled");
  const replay = await page.evaluate(async () => {
    const z = (window as any).__zapp;
    return z.runtime.request("terminal.attach", {
      id: (window as any).__terminalId,
      afterSeq: 0,
    });
  });
  expect(replay.chunks.map((c: any) => c.data).join("")).toContain(
    "ZAPP_TERMINAL_OK",
  );
});

test("stage and commit actual Git changes without repeating a request", async ({
  page,
}) => {
  await runtime(page);
  const result = await page.evaluate(async () => {
    const z = (window as any).__zapp;
    await z.filesystem.write("commit-proof.txt", "real git commit\n", {
      expectedRevision: null,
    });
    const git = z.kernel.services.get("git");
    await git.stage("commit-proof.txt");
    const diff = await z.runtime.request("git.diff", {
      path: "commit-proof.txt",
      staged: true,
    });
    const id = "browser-commit-proof";
    const first = await z.runtime.request(
      "git.commit",
      { message: "Verify real browser commit" },
      { id },
    );
    const repeated = await z.runtime.request(
      "git.commit",
      { message: "Verify real browser commit" },
      { id },
    );
    const operation = await z.runtime.request("operation.status", { id });
    return { diff, first, repeated, operation };
  });
  expect(result.diff.after).toContain("real git commit");
  expect(result.repeated).toEqual(result.first);
  expect(result.operation.status).toBe("completed");
});

test("two independent browsers converge concurrent offline edits and keep per-user undo", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const left = await a.newPage(),
    right = await b.newPage();
  try {
    await runtime(left);
    await runtime(right);
    await open(left, "collab.ts");
    await open(right, "collab.ts");
    await right.evaluate(() => (window as any).__zapp.runtime.disconnect());
    await Promise.all([
      left.evaluate(() => {
        const d = (window as any).__zapp.documents.get("collab.ts");
        d.transact([{ from: 0, to: 0, insert: "// Alice\n" }]);
      }),
      right.evaluate(() => {
        const d = (window as any).__zapp.documents.get("collab.ts");
        d.transact([{ from: 0, to: 0, insert: "// Bob\n" }]);
      }),
    ]);
    await right.evaluate(async () => {
      await (window as any).__zapp.runtime.connect();
      await (window as any).__zapp.kernel.services
        .get("collaboration")
        .resync();
    });
    await expect
      .poll(
        async () =>
          (await text(left, "collab.ts")) === (await text(right, "collab.ts")),
      )
      .toBe(true);
    expect(await text(left, "collab.ts")).toContain("// Alice");
    expect(await text(left, "collab.ts")).toContain("// Bob");
    await right.evaluate(() =>
      (window as any).__zapp.documents.get("collab.ts").undo.undo(),
    );
    await expect.poll(() => text(left, "collab.ts")).not.toContain("// Bob");
    expect(await text(left, "collab.ts")).toContain("// Alice");
    await left.screenshot({ path: "evidence/collaboration-left.png" });
    await right.screenshot({ path: "evidence/collaboration-right.png" });
  } finally {
    await a.close();
    await b.close();
  }
});

test("external SDK extension lifecycle removes contributions and survives failed activation", async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const z = (window as any).__zapp;
    const existing = z.kernel.extensions
      .list()
      .find((e: any) => e.manifest.name === "Bundle Inspector");
    if (existing) await z.kernel.extensions.remove(existing.manifest.id);
    const publicSdk = await import(location.origin + "/sdk/index.js");
    if (
      publicSdk.SDK_VERSION !== "1.0.0" ||
      publicSdk.languageIdForPath("file.tsx") !== "tsx"
    )
      throw new Error("Public SDK facade mismatch");
    const id = await z.kernel.extensions.load(
      location.origin + "/extensions/bundle-inspector.js",
    );
    await z.kernel.commands.execute("bundle.analyze");
    const active = z.kernel.contributions.list().map((c: any) => c.id);
    for (let i = 0; i < 15; i++) {
      await z.kernel.extensions.disable(id);
      await z.kernel.extensions.activate(id);
    }
    await z.kernel.extensions.disable(id);
    const disabled = z.kernel.contributions.list().map((c: any) => c.id);
    let fail = true;
    z.kernel.extensions.register({
      manifest: {
        manifestVersion: 1,
        id: "test.failure",
        name: "Failure probe",
        version: "1.0.0",
        sdk: "^1.0.0",
        environments: ["browser"],
        activation: [],
        capabilities: [],
      },
      activate(ctx: any) {
        ctx.contributions.register({
          id: "test.failure.panel",
          kind: "panel",
          title: "Failure",
        });
        if (fail) throw new Error("Injected activation failure");
      },
    });
    try {
      await z.kernel.extensions.activate("test.failure");
    } catch {}
    const rolledBack = !z.kernel.contributions
      .list()
      .some((c: any) => c.id === "test.failure.panel");
    fail = false;
    await z.kernel.extensions.activate("test.failure");
    return {
      active,
      disabled,
      rolledBack,
      recovered: z.kernel.extensions
        .list()
        .find((e: any) => e.manifest.id === "test.failure").state,
    };
  });
  expect(result.active).toContain("bundle");
  expect(result.disabled).not.toContain("bundle");
  expect(result.disabled).not.toContain("bundle.report");
  expect(result.rolledBack).toBe(true);
  expect(result.recovered).toBe("active");
});

test("both themes render at all four reference viewports with visual comparison artifacts", async ({
  page,
}) => {
  await mkdir("evidence/visual", { recursive: true });
  const results = [];
  for (const [name, width, height] of [
    ["desktop", 1440, 900],
    ["tablet-landscape", 1024, 768],
    ["tablet-portrait", 768, 1024],
    ["phone", 390, 844],
  ] as const)
    for (const theme of ["dark", "light"]) {
      await page.setViewportSize({ width, height });
      await ready(page);
      await page.evaluate(async (theme) => {
        const z = (window as any).__zapp;
        z.kernel.configuration.set(
          "workbench.colorTheme",
          theme === "dark" ? "Graphite (dark)" : "Paper (light)",
        );
        z.workbench.resetLayout();
        await z.workbench.openFile("src/hooks/useTelemetry.ts", {
          preview: false,
        });
      }, theme);
      await page.waitForTimeout(300);
      const file = `evidence/visual/${name}-${theme}.png`;
      const png = await page.screenshot({ path: file });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const baseline = await readFile(`design/baselines/${name}-${theme}.png`);
      const comparison = await page.evaluate(
        async ({ a, b }) => {
          const load = (src: string) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const image = new Image();
              image.onload = () => resolve(image);
              image.onerror = reject;
              image.src = "data:image/png;base64," + src;
            });
          const [ref, actual] = await Promise.all([load(a), load(b)]);
          const canvas = document.createElement("canvas");
          canvas.width = ref.width;
          canvas.height = ref.height;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(ref, 0, 0);
          const x = ctx.getImageData(0, 0, ref.width, ref.height).data;
          ctx.clearRect(0, 0, ref.width, ref.height);
          ctx.drawImage(actual, 0, 0);
          const y = ctx.getImageData(0, 0, ref.width, ref.height).data;
          let changed = 0;
          for (let i = 0; i < x.length; i += 4)
            if (
              Math.max(
                Math.abs(x[i] - y[i]),
                Math.abs(x[i + 1] - y[i + 1]),
                Math.abs(x[i + 2] - y[i + 2]),
              ) > 25
            )
              changed++;
          return {
            width: actual.width,
            height: actual.height,
            changedPixels: changed,
            totalPixels: actual.width * actual.height,
            ratio: changed / (actual.width * actual.height),
          };
        },
        { a: baseline.toString("base64"), b: png.toString("base64") },
      );
      expect(comparison.width).toBe(width);
      expect(comparison.height).toBe(height);
      results.push({ name, theme, ...comparison });
    }
  await writeFile(
    "evidence/visual/comparison.json",
    JSON.stringify(results, null, 2),
  );
});

test("Unicode, synthetic composition, multiple cursors and local paint latency", async ({
  page,
  browserName,
}) => {
  await ready(page);
  await open(page, "README.md");
  await page.evaluate(() => {
    const z = (window as any).__zapp;
    z.documents.get("README.md").replace("first\nsecond\n");
  });
  await page.waitForTimeout(100);
  await page.locator(".cm-content").first().focus();
  await page
    .locator(".cm-content")
    .first()
    .dispatchEvent("compositionstart", { data: "" });
  await page.keyboard.insertText("漢字🙂");
  await page
    .locator(".cm-content")
    .first()
    .dispatchEvent("compositionend", { data: "漢字🙂" });
  expect(await text(page, "README.md")).toContain("漢字🙂");
  await page.evaluate(() => {
    const view = (window as any).__zapp.workbench.activeEditor();
    const selection = view.state.selection.constructor;
    view.dispatch({
      selection: selection.create([
        selection.cursor(0),
        selection.cursor(view.state.doc.line(2).from),
      ]),
    });
  });
  await page.keyboard.type("X");
  expect((await text(page, "README.md")).split("X")).toHaveLength(3);
  await page.evaluate(() => {
    const view = (window as any).__zapp.workbench.activeEditor();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    (window as any).__paints = [];
    window.addEventListener("keydown", () => {
      const start = performance.now();
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          (window as any).__paints.push(performance.now() - start),
        ),
      );
    });
  });
  for (let i = 0; i < 60; i++) await page.keyboard.type("a", { delay: 18 });
  await page.waitForTimeout(80);
  const paints = await page.evaluate(
    () => (window as any).__paints as number[],
  );
  const switches = [];
  for (let i = 0; i < 30; i++) {
    await open(page, i % 2 ? "README.md" : "src/App.tsx");
    await page.waitForTimeout(20);
  }
  const measurements = await page.evaluate(() =>
    performance
      .getEntriesByName("zapp.file-switch")
      .map((e) => e.duration)
      .slice(-30),
  );
  switches.push(...measurements);
  const p95 = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] ?? 0;
  const report = {
    hardware: {
      cpus: os.cpus().length,
      model: os.cpus()[0].model,
      architecture: os.arch(),
      memory: os.totalmem(),
    },
    browser: browserName,
    userAgent: await page.evaluate(() => navigator.userAgent),
    dataset:
      "orbit-dash design fixture; README typing and cached App.tsx/README switching",
    method:
      "keydown to second requestAnimationFrame; workbench openFile to following animation frame",
    typing: { samples: paints.length, p95: p95(paints), target: 50 },
    switching: { samples: switches.length, p95: p95(switches), target: 100 },
  };
  await writeFile("evidence/performance.json", JSON.stringify(report, null, 2));
  expect(paints.length).toBeGreaterThan(30);
  expect(report.typing.p95).toBeLessThanOrEqual(50);
  expect(report.switching.p95).toBeLessThanOrEqual(100);
});

test("sustained editing and repeated switching keep document and extension state", async ({
  page,
}) => {
  test.setTimeout(180000);
  await ready(page);
  const started = Date.now();
  let rounds = 0;
  while (Date.now() - started < 120000) {
    await page.evaluate(async (n) => {
      const z = (window as any).__zapp;
      await z.workbench.openFile("README.md");
      const doc = z.documents.get("README.md");
      doc.replace("# Sustained session\n" + n + " 🐱\n");
      if (n % 10 === 0) await z.documents.save("README.md");
      await z.workbench.openFile("src/App.tsx");
    }, rounds++);
    await page.waitForTimeout(500);
  }
  await page.evaluate(async () => {
    await (window as any).__zapp.documents.persist();
  });
  await page.reload();
  await page.waitForFunction(() => (window as any).__zapp?.ready === true);
  expect(await text(page, "README.md")).toContain("Sustained session");
  await writeFile(
    "evidence/sustained-session.json",
    JSON.stringify(
      {
        durationMs: Date.now() - started,
        rounds,
        refreshRecovery: true,
        kind: "automated two-minute session",
      },
      null,
      2,
    ),
  );
});

test("runtime process loss preserves browser drafts and reports lost PTYs", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zapp-browser-recovery-"));
  await writeFile(
    path.join(root, "recovery.ts"),
    'export const recovery = "initial";\n',
  );
  let server = await createRuntime({
    root,
    port: 0,
    dataDir: root + "-state",
    pairingCode: "recovery-pair",
  });
  const port = server.port;
  const url = "http://127.0.0.1:" + port;
  try {
    await page.goto(url);
    await page.waitForFunction(() => (window as any).__zapp?.ready === true);
    await page.evaluate(async (url) => {
      await (window as any).__zapp.connectRuntime(url, "recovery-pair");
      await (window as any).__zapp.runtime.trust(true);
    }, url);
    await open(page, "recovery.ts");
    const sessionId = await page.evaluate(
      async () =>
        (await (window as any).__zapp.kernel.services.get("terminal").create())
          .id,
    );
    await server.close();
    await page.evaluate(async () => {
      const z = (window as any).__zapp;
      z.documents
        .get("recovery.ts")
        .replace('export const recovery = "survived runtime loss";\n');
      await z.documents.persist();
    });
    server = await createRuntime({
      root,
      port,
      dataDir: root + "-state",
      pairingCode: "recovery-pair",
    });
    await expect
      .poll(
        () => page.evaluate(() => (window as any).__zapp.runtime.connected),
        { timeout: 30000 },
      )
      .toBe(true);
    await page.evaluate(async () => {
      const z = (window as any).__zapp;
      await z.kernel.services.get("collaboration").resync();
      await z.documents.save("recovery.ts");
    });
    expect(await readFile(path.join(root, "recovery.ts"), "utf8")).toContain(
      "survived runtime loss",
    );
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (window as any).__zapp.kernel.services
              .get("terminal")
              .sessions.get(id)?.state,
          sessionId,
        ),
      )
      .toContain("terminated");
    await page.screenshot({ path: "evidence/runtime-recovery.png" });
  } finally {
    await server.close();
  }
});

test("replacement preview groups files and keeps deselected files available", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    await z.filesystem.write("preview-a.txt", "needle a", {
      expectedRevision: null,
    });
    await z.filesystem.write("preview-b.txt", "needle b", {
      expectedRevision: null,
    });
    await z.kernel.commands.execute("view.search");
  });
  const panel = page.locator(".feature-search");
  await panel
    .getByRole("textbox", { name: "Search files", exact: true })
    .fill("needle");
  await panel
    .getByRole("textbox", { name: "Files to include", exact: true })
    .fill("preview-*.txt");
  await panel
    .getByRole("textbox", { name: "Replace text", exact: true })
    .fill("replacement");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(2);
  await panel
    .getByRole("button", { name: "Preview replacement", exact: true })
    .click();
  const selected = panel.getByRole("checkbox", {
    name: "Replace in preview-a.txt",
    exact: true,
  });
  await selected.uncheck();
  await expect(selected).not.toBeChecked();
  await expect(panel.getByRole("listitem")).toHaveCount(2);
  await selected.check();
  await panel
    .getByRole("checkbox", { name: "Replace in preview-b.txt", exact: true })
    .uncheck();
  await panel
    .getByRole("button", { name: "Apply replacements", exact: true })
    .click();
  await expect.poll(() => text(page, "preview-a.txt")).toBe("replacement a");
  expect(await text(page, "preview-b.txt")).toBe("needle b");
});

test("formatter workers obey language scope and Markdown preview opens beside its source", async ({
  page,
}) => {
  await ready(page);
  await open(page, "src/App.tsx");
  const result = await page.evaluate(async () => {
    const z = (window as any).__zapp;
    z.kernel.configuration.set(
      "editor.defaultFormatter",
      "zapp.builtin-ts",
      "workspace",
      "tsx",
    );
    z.kernel.configuration.set("editor.tabSize", 4, "workspace", "tsx");
    const doc = z.documents.get("src/App.tsx");
    doc.replace("const x={value:1};\n");
    await z.kernel.commands.execute("editor.format");
    const typescript = doc.text.toString();
    z.kernel.configuration.set(
      "editor.defaultFormatter",
      "zapp.prettier",
      "workspace",
      "tsx",
    );
    await z.kernel.commands.execute("editor.format");
    return { typescript, prettier: doc.text.toString() };
  });
  expect(result.typescript).toContain("const x =");
  expect(result.prettier).toContain("value: 1");
  await open(page, "README.md");
  await page.evaluate(async () =>
    (window as any).__zapp.kernel.commands.execute("preview.markdownSide"),
  );
  await expect(
    page.getByRole("article", { name: "Markdown preview" }),
  ).toBeVisible();
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => (window as any).__zapp.workbench.state.groups.length,
    ),
  ).toBe(2);
  await page.evaluate(async () =>
    (window as any).__zapp.kernel.extensions.disable("zapp.previews"),
  );
  await expect(
    page.getByRole("article", { name: "Markdown preview" }),
  ).toHaveCount(0);
});

test("native browser directory handles retain identity, encoded saves and drafts after refresh", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).showDirectoryPicker = async () =>
      navigator.storage.getDirectory();
  });
  await ready(page);
  await page.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    const file = await directory.getFileHandle("native.txt", { create: true });
    const writable = await file.createWritable();
    await writable.write("native before");
    await writable.close();
    await (window as any).__zapp.kernel.commands.execute("workspace.open");
  });
  await page.getByRole("button", { name: /Open directory/ }).click();
  await page.waitForFunction(
    () =>
      (window as any).__zapp?.ready &&
      (window as any).__zapp.filesystem.id.startsWith("directory:"),
  );
  const id = await page.evaluate(() => (window as any).__zapp.filesystem.id);
  await open(page, "native.txt");
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    const doc = z.documents.get("native.txt");
    doc.replace("café");
    doc.encoding = "latin1";
    await z.documents.save("native.txt");
    doc.replace("café unsaved");
    await z.documents.persist();
  });
  let confirmedReload = false;
  page.once("dialog", async (dialog) => {
    confirmedReload = dialog.type() === "beforeunload";
    await dialog.accept();
  });
  const refreshed = page.waitForEvent("domcontentloaded");
  await page.evaluate(() => location.reload());
  await refreshed;
  expect(confirmedReload).toBe(true);
  await page.waitForFunction(() => (window as any).__zapp?.ready);
  expect(await page.evaluate(() => (window as any).__zapp.filesystem.id)).toBe(
    id,
  );
  expect(await text(page, "native.txt")).toBe("café unsaved");
  expect(
    await page.evaluate(async () => {
      const file = await (
        await navigator.storage.getDirectory()
      ).getFileHandle("native.txt");
      return [...new Uint8Array(await (await file.getFile()).arrayBuffer())];
    }),
  ).toEqual([99, 97, 102, 233]);
});

test("browser IME composition commits and cancels without duplicate text", async ({
  page,
  context,
}) => {
  await ready(page);
  await open(page, "README.md");
  await page.evaluate(() =>
    (window as any).__zapp.documents.get("README.md").replace(""),
  );
  await page.locator(".cm-content").focus();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "に",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await cdp.send("Input.imeSetComposition", {
    text: "日本語",
    selectionStart: 3,
    selectionEnd: 3,
  });
  await cdp.send("Input.insertText", { text: "日本語" });
  await expect.poll(() => text(page, "README.md")).toBe("日本語");
  await cdp.send("Input.imeSetComposition", {
    text: "取消",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await cdp.send("Input.imeSetComposition", {
    text: "",
    selectionStart: 0,
    selectionEnd: 0,
  });
  await expect.poll(() => text(page, "README.md")).toBe("日本語");
  await cdp.detach();
});

test("phone touch navigation and reduced motion preserve focus and layout", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await ready(page);
    await page
      .getByRole("navigation", { name: "Primary views" })
      .getByRole("button", { name: "Search", exact: true })
      .tap();
    await expect(
      page.getByRole("textbox", { name: "Search files", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Search files", exact: true })
      .tap();
    await page.keyboard.insertText("telemetry");
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: "evidence/touch-phone.png" });
  } finally {
    await context.close();
  }
});

test("a contributed filesystem opens through the workspace UI and survives provider teardown", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    const FileSystem = z.filesystem.constructor;
    const storage = z.kernel.services.get("persistence");
    const filesystem = new FileSystem(storage, "provider-proof");
    await filesystem.write("provider.ts", "export const provider = true;\n", {
      expectedRevision: null,
    });
    z.kernel.extensions.register({
      manifest: {
        manifestVersion: 1,
        id: "test.filesystem",
        name: "Filesystem provider",
        version: "1.0.0",
        sdk: "^1.0.0",
        environments: ["browser"],
        activation: [],
        capabilities: ["filesystem.read", "filesystem.write"],
      },
      activate(ctx: any) {
        (window as any).__providerSignal = ctx.signal;
        ctx.contributions.register({
          id: "test.filesystem",
          kind: "filesystem",
          title: "Test filesystem",
          data: { open: () => filesystem },
        });
      },
    });
    await z.kernel.extensions.activate("test.filesystem");
    await z.kernel.commands.execute("workspace.open");
  });
  await page
    .getByRole("button", { name: "Test filesystem", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      (window as any).__zapp?.ready &&
      (window as any).__zapp.filesystem.id === "provider-proof",
  );
  expect(
    await page.evaluate(() => (window as any).__providerSignal.aborted),
  ).toBe(true);
  await open(page, "provider.ts");
  await page.evaluate(async () => {
    const z = (window as any).__zapp;
    z.documents
      .get("provider.ts")
      .replace("export const provider = 'saved';\n");
    await z.documents.save("provider.ts");
  });
  expect(
    await page.evaluate(
      async () =>
        (await (window as any).__zapp.filesystem.read("provider.ts")).text,
    ),
  ).toContain("'saved'");
});
