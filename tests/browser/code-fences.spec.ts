import { expect, test, type Page } from "@playwright/test";

const README = ["# Demo", "", "Text before.", "", "```ts", "const message: string = 42;", "message.toUp", "```", "", "```json", "{ \"a\": 1 }", "```", ""].join("\n");

async function open(page: Page, path: string, text: string) {
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async ({ path, text }) => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    await app.runtime.request("fs.write", { path, text, expectedRevision: null });
    await app.openFile(path);
  }, { path, text });
}

const diagnostics = (page: Page, path: string) => page.evaluate(path => ((window as any).__oxbit.kernel.services.get("language").diagnostics.get(path) ?? []).map((item: any) => `${item.range.start.line}:${item.range.start.character} ${item.message}`), path);

test("Markdown fences get syntax highlighting, problems, hover and completion from the fence language's server", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await open(page, "fences.md", README);
  const fenceLine = page.locator(".cm-line", { hasText: "const message: string = 42;" });
  await expect.poll(() => fenceLine.locator("span").count()).toBeGreaterThan(2);
  await expect.poll(() => diagnostics(page, "fences.md"), { timeout: 30_000 }).toContainEqual(expect.stringMatching(/^5:6 Type 'number' is not assignable to type 'string'/));
  await expect(page.locator(".cm-lintRange-error").first()).toBeVisible();
  const paths = await page.evaluate(() => [...(window as any).__oxbit.documents.documents.keys()]);
  expect(paths.filter((path: string) => path.includes(".fence-"))).toEqual([]);

  await page.evaluate(() => { const view = (window as any).__oxbit.workbench.activeEditor(); view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("message.toUp") + "message.toUp".length } }); view.focus(); });
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("toUpperCase");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.documents.get("fences.md").text.toString())).toContain("message.toUpperCase");

  await page.evaluate(async () => {
    const app = (window as any).__oxbit, view = app.workbench.activeEditor();
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("message:") + 2 } }); view.focus();
    const pos = view.coordsAtPos(view.state.selection.main.head);
    view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { clientX: pos.left + 2, clientY: pos.top + 4, bubbles: true }));
  });
  await expect(page.locator(".cm-tooltip-hover")).toContainText("const message: string");

  await page.evaluate(() => (window as any).__oxbit.kernel.configuration.set("editor.embeddedCode.languageServers", false, "user"));
  await expect.poll(() => diagnostics(page, "fences.md")).toEqual([]);
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  await page.evaluate(() => (window as any).__oxbit.kernel.configuration.set("editor.embeddedCode.highlighting", false, "user"));
  await expect.poll(() => fenceLine.locator("span").count()).toBeLessThan(2);
  await page.evaluate(() => { const configuration = (window as any).__oxbit.kernel.configuration; configuration.set("editor.embeddedCode.languageServers", true, "user"); configuration.set("editor.embeddedCode.highlighting", true, "user"); });
  await expect.poll(() => diagnostics(page, "fences.md"), { timeout: 30_000 }).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("fences inside doc comments are highlighted and checked", async ({ page }) => {
  const source = ["/**", " * Adds numbers.", " * ```ts", " * const total: string = 1 + 2;", " * ```", " */", "export function add(a: number, b: number) { return a + b; }", ""].join("\n");
  await open(page, "fence-comment.ts", source);
  await expect.poll(() => page.locator(".cm-line", { hasText: "const total" }).locator("span").count()).toBeGreaterThan(2);
  await expect.poll(() => diagnostics(page, "fence-comment.ts"), { timeout: 30_000 }).toContainEqual(expect.stringMatching(/^3:9 Type 'number' is not assignable to type 'string'/));
});
