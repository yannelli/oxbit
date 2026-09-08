import { expect, test } from "@playwright/test";

test("Astro resolves and applies completions across embedded languages", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    await app.runtime.request("fs.write", { path: "embedded.astro", expectedRevision: null, text: [
      "---", '// 😀 frontmatter', 'const message = "hello";', 'const result = message.toUp;', '---',
      '<h1>{message.toLower}</h1>', '<script>', 'const client = "hello";', 'client.toUp;', '</script>',
      '<style>', 'h1 { color: red; }', '</style>', '',
    ].join("\n") });
    await app.openFile("embedded.astro");
    await app.kernel.services.get("language").serviceForPath("embedded.astro").start(true);
  });
  const text = () => page.evaluate(() => (window as any).__oxbit.documents.get("embedded.astro").text.toString());
  for (const [fragment, completed] of [["result = message.toUp", "result = message.toUpperCase"], ["{message.toLower", "{message.toLowerCase"], ["client.toUp", "client.toUpperCase"]]) {
    await page.evaluate(fragment => {
      const view = (window as any).__oxbit.workbench.activeEditor();
      const offset = view.state.doc.toString().indexOf(fragment);
      if (offset < 0) throw new Error(`Missing marker ${fragment}`);
      view.dispatch({ selection: { anchor: offset + fragment.length } }); view.focus();
    }, fragment);
    await page.keyboard.press("Control+Space");
    await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
    await expect(page.locator(".cm-completionInfo")).toContainText("Converts all the alphabetic characters");
    await page.keyboard.press("Enter");
    await expect.poll(text).toContain(completed);
  }
  for (const [marker, documentation] of [["color: red", "Sets the color"], ["h1>", "IntrinsicElements.h1"]]) {
    await page.evaluate(async marker => {
      const app = (window as any).__oxbit, view = app.workbench.activeEditor();
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(marker) + 1 } }); view.focus();
      await app.kernel.commands.execute("editor.hover");
    }, marker);
    await expect(page.locator(".lsp-tooltip")).toContainText(documentation);
    await page.keyboard.press("Escape");
  }
  expect(await text()).toContain("// 😀 frontmatter");
  expect(await text()).toContain("h1 { color: red; }");
  expect(errors).toEqual([]);
});

test("Astro auto-import completion inserts its import inside frontmatter", async ({ page }) => {
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    for (const [path, text] of [
      ["tsconfig.json", '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","target":"ES2022"},"include":["*.ts","*.astro"]}'],
      ["embedded-helpers.ts", '/** Returns a friendly greeting. */\nexport function welcomeUser(name: string) { return "Hello " + name; }'],
      ["embedded-import.astro", '---\n// 😀 keep imports here\nwelcomeUs\n---\n<h1>Hello</h1>\n'],
    ]) await app.runtime.request("fs.write", { path, text, expectedRevision: null });
    await app.openFile("embedded-import.astro");
    await app.kernel.services.get("language").serviceForPath("embedded-import.astro").start(true);
    const view = app.workbench.activeEditor();
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("welcomeUs") + 9 } }); view.focus();
  });
  await expect.poll(() => page.evaluate(async () => {
    const app = (window as any).__oxbit, view = app.workbench.activeEditor();
    const result = await app.kernel.services.get("language").serviceForPath("embedded-import.astro").at("textDocument/completion", "embedded-import.astro", view.state.selection.main.head, { context: { triggerKind: 1 } });
    return (Array.isArray(result) ? result : result?.items ?? []).map((item: any) => item.label);
  })).toContain("welcomeUser");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("welcomeUser");
  await expect(page.locator(".cm-completionInfo")).toContainText("Returns a friendly greeting.");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.documents.get("embedded-import.astro").text.toString())).toMatch(/^---\nimport \{ welcomeUser \} from ["']\.\/embedded-helpers["'];\n/);
  const text = await page.evaluate(() => (window as any).__oxbit.documents.get("embedded-import.astro").text.toString());
  expect(text).toContain("\nwelcomeUser\n---\n<h1>Hello</h1>\n");
});
