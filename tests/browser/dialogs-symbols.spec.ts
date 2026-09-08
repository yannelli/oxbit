import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime";

async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await expect(page.locator(".cm-editor").first()).toBeVisible();
}
async function run(page: Page, command: string) {
  await page.evaluate(
    (command) => (window as any).__oxbit.workbench.run(command),
    command,
  );
}

test("failed symbol initialization stays visible without repeatedly restarting the server", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const app = (window as any).__oxbit;
    (window as any).__symbolStarts = 0;
    app.kernel.contributions.register({
      id: "test.failing-symbols",
      kind: "transport",
      title: "Failing symbols fixture",
      data: {
        languages: ["typescript"],
        createTransport: () => ({
          async request(method: string) {
            if (method === "initialize") {
              (window as any).__symbolStarts++;
              throw new Error("Fixture language server failed to start.");
            }
            return null;
          },
          notify() {},
          onNotification() {
            return { dispose() {} };
          },
          dispose() {},
        }),
      },
    });
  });
  await run(page, "workbench.gotoSymbol");
  await expect(page.getByRole("dialog")).toContainText(
    "Fixture language server failed to start.",
  );
  // Allow multiple debounce intervals so an accidental failure/retry loop is observable.
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as any).__symbolStarts)).toBe(1);
});

test("workspace and About dialogs follow every theme on desktop and phone", async ({
  page,
}, info) => {
  await ready(page);
  for (const theme of [
    "Graphite (dark)",
    "Paper (light)",
    "Load Bearing (dark)",
    "Load Bearing (light)",
  ]) {
    await page.evaluate(
      (theme) =>
        (window as any).__oxbit.kernel.configuration.set(
          "workbench.colorTheme",
          theme,
        ),
      theme,
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const command of ["workspace.open", "help.about"]) {
        await run(page, command);
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await dialog.evaluate((element) =>
          Promise.all(
            element.getAnimations().map((animation) => animation.finished),
          ),
        );
        expect(
          await dialog.evaluate((element) => {
            const actual = getComputedStyle(element);
            const workbench = getComputedStyle(
              document.querySelector(".workbench")!,
            );
            return (
              actual.getPropertyValue("--bg-raised").trim() ===
                workbench.getPropertyValue("--bg-raised").trim() &&
              actual.getPropertyValue("--accent").trim() ===
                workbench.getPropertyValue("--accent").trim()
            );
          }),
        ).toBe(true);
        const bounds = (await dialog.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(
          await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth),
        ).toBe(true);
        if (command === "help.about") {
          await expect(
            dialog.getByRole("img", { name: "Oxbit" }),
          ).toBeVisible();
          await expect(
            dialog.getByRole("link", { name: "Source code" }),
          ).toHaveAttribute("href", "https://github.com/yannelli/oxbit");
          await expect(
            dialog.getByRole("link", { name: "MIT License" }),
          ).toHaveAttribute("href", "/LICENSE.txt");
          await dialog.getByText("Built with", { exact: true }).click();
          await expect(
            dialog.getByText("CodeMirror", { exact: true }),
          ).toBeVisible();
        } else {
          await expect(
            dialog.getByRole("button", { name: /Open directory/ }),
          ).toBeVisible();
          await expect(
            dialog.getByRole("button", {
              name: "Import workspace…",
              exact: true,
            }),
          ).toBeVisible();
        }
        if (theme.startsWith("Load Bearing"))
          await page.screenshot({
            path: info.outputPath(`${command}-${theme}-${width}.png`),
          });
        await dialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await expect(dialog).toHaveCount(0);
      }
    }
  }
});

test("dialog keyboard actions trap focus and preserve workspace actions", async ({
  page,
}) => {
  await ready(page);
  await run(page, "help.about");
  const dialog = page.getByRole("dialog");
  const done = dialog.getByRole("button", { name: "Done", exact: true });
  await done.focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(done).toBeFocused();
  await done.click();
  await expect(dialog).toHaveCount(0);
  await run(page, "workspace.open");
  const chooser = page.waitForEvent("filechooser");
  await dialog
    .getByRole("button", { name: "Import workspace…", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  expect((await chooser).isMultiple()).toBe(false);
  await dialog.getByRole("button", { name: /Connect to a runtime/ }).click();
  await expect(dialog).toHaveAttribute("aria-label", "Runtime Connection");
});

test("symbols explain when the browser workspace has no language server", async ({
  page,
}) => {
  await ready(page);
  await run(page, "workbench.gotoSymbol");
  await expect(page.getByRole("dialog")).toContainText(
    "Connect and trust a runtime workspace to load symbols.",
  );
  await page.keyboard.press("Escape");
  await page.locator(".outline > summary").click();
  await expect(page.locator(".document-outline")).toContainText(
    "Connect and trust a runtime workspace to load symbols.",
  );
});

test("real TypeScript symbols populate Outline and Quick Open, navigate, and follow edits and file changes", async ({
  page,
}) => {
  await ready(page);
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "oxbit-symbols-browser-"),
  );
  const text =
    "export class Ledger {\n  total = 0;\n  add(amount: number) {\n    this.total += amount;\n  }\n}\n\nexport function greet(name: string) {\n  return `Hello ${name}`;\n}\n";
  await writeFile(join(root, "symbols.ts"), text);
  await writeFile(join(root, "other.ts"), "export const otherValue = 42;\n");
  await writeFile(
    join(root, "package.json"),
    '{"name":"symbols-fixture","private":true}',
  );
  const runtime = await createRuntime({
    root,
    dataDir: join(root, ".runtime"),
    host: "127.0.0.1",
    port: 0,
    pairingCode: "symbols-browser-test",
    webRoot: process.env.OXBIT_TEST_WEB_ROOT
      ? await realpath(process.env.OXBIT_TEST_WEB_ROOT)
      : undefined,
  });
  try {
    await page.goto(`http://127.0.0.1:${runtime.port}/`);
    await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
    await page.evaluate(async (url) => {
      await (window as any).__oxbit.connectRuntime(url, "symbols-browser-test");
      const app = (window as any).__oxbit;
      await app.runtime.trust(true);
      await app.workbench.openFile("symbols.ts", { preview: false });
    }, `http://127.0.0.1:${runtime.port}`);
    await run(page, "workbench.gotoSymbol");
    const palette = page.getByRole("dialog", { name: "Quick Open" });
    await expect(palette.getByRole("option", { name: /Ledger/ })).toBeVisible();
    await expect(palette.getByRole("option", { name: /greet/ })).toBeVisible();
    await palette.getByRole("combobox").fill("@greet");
    await page.keyboard.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const editor = (window as any).__oxbit.workbench.activeEditor();
          return editor.state.doc.lineAt(editor.state.selection.main.head)
            .number;
        }),
      )
      .toBe(8);
    await page.locator(".outline > summary").click();
    const outline = page.getByRole("navigation", { name: "Document symbols" });
    await expect(
      outline.getByRole("button", { name: "add Method", exact: true }),
    ).toBeVisible();
    await outline
      .getByRole("button", { name: "add Method", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const editor = (window as any).__oxbit.workbench.activeEditor();
          return editor.state.doc.lineAt(editor.state.selection.main.head)
            .number;
        }),
      )
      .toBe(3);
    await page.evaluate(() => {
      const app = (window as any).__oxbit;
      app.documents
        .get("symbols.ts")
        .replace("export function freshSymbol() {}\n");
    });
    await expect(
      outline.getByRole("button", {
        name: "freshSymbol Function",
        exact: true,
      }),
    ).toBeVisible();
    await expect(outline.getByRole("button", { name: /Ledger/ })).toHaveCount(
      0,
    );
    await run(page, "editor.symbols");
    await expect(
      palette.getByRole("option", { name: /freshSymbol/ }),
    ).toBeVisible();
    await page.evaluate(() =>
      (window as any).__oxbit.workbench.openFile("other.ts", {
        preview: false,
      }),
    );
    await expect(
      palette.getByRole("option", { name: /otherValue/ }),
    ).toBeVisible();
    await expect(
      palette.getByRole("option", { name: /freshSymbol/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(
      outline.getByRole("button", { name: /otherValue/ }),
    ).toBeVisible();
  } finally {
    await page.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
