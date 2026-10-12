import { expect, test } from "@playwright/test";

test("settings UI writes JSON and follows merged project overrides across windows", async ({ page, context }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(() => (window as any).__oxbit.kernel.commands.execute("settings.open"));
  await page.getByRole("textbox", { name: "Search settings" }).fill("editor.tabSize");
  const input = page.locator('input[type="number"]');
  await expect(input).toHaveCount(1); await input.fill("3"); await input.blur();
  await expect.poll(() => page.evaluate(async () => {
    const app = (window as any).__oxbit; await app.kernel.configuration.flush();
    return (await app.runtime.request("settings.read")).layers.user["editor.tabSize"];
  })).toBe(3);
  const other = await context.newPage(); other.on("pageerror", error => errors.push(error.message));
  await other.goto("/#pair=oxbit-acceptance-2026"); await other.waitForFunction(() => (window as any).__oxbit?.ready);
  await expect.poll(() => other.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.tabSize"))).toBe(3);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    app.kernel.configuration.set("languageServers", { json: { enabled: true, settings: { json: { validate: { enable: true } } } } }, "user");
    app.kernel.configuration.set("languageServers", { json: { settings: { json: { schemaDownload: { enable: false } } } } }, "workspace");
    await app.kernel.configuration.flush();
    await app.runtime.request("fs.mkdir", { path: ".config" });
    await app.runtime.request("fs.mkdir", { path: ".config/oxbit" });
    await app.runtime.request("fs.write", { path: ".config/oxbit/settings.json", text: '{"editor.tabSize":4,"languageServers":{"json":{"settings":{"json":{"format":{"enable":false}}}}}}', expectedRevision: null });
    await app.runtime.request("fs.write", { path: ".config/oxbit/settings.local.json", text: '{"editor.tabSize":6}', expectedRevision: null });
  });
  await expect.poll(() => other.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.tabSize"))).toBe(6);
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.configuration.get("languageServers").json)).toEqual({ enabled: true, settings: { json: { validate: { enable: true }, schemaDownload: { enable: false }, format: { enable: false } } } });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(input).toHaveValue("6"); await input.fill("7"); await input.blur();
  await expect.poll(() => page.evaluate(async () => JSON.parse((await (window as any).__oxbit.runtime.request("fs.read", { path: ".config/oxbit/settings.local.json" })).text)["editor.tabSize"])).toBe(7);
  await expect.poll(() => other.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.tabSize"))).toBe(7);
  await page.screenshot({ path: "evidence/settings-files/desktop.png" });
  await page.evaluate(async () => {
    const app = (window as any).__oxbit, file = await app.runtime.request("fs.read", { path: ".config/oxbit/settings.local.json" });
    await app.runtime.request("fs.delete", { path: file.path, expectedRevision: file.revision });
  });
  await expect.poll(() => other.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.tabSize"))).toBe(4);
  await page.reload(); await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.tabSize"))).toBe(4);
  const snapshot = await page.evaluate(() => (window as any).__oxbit.runtime.request("settings.read"));
  expect(snapshot.files.map((file: any) => file.exists)).toEqual([true, true, true, false]);
  expect(snapshot.files[0].path).toMatch(/settings\.json$/);
  expect(snapshot.files[1].path).toMatch(/projects\/[\da-f-]{36}\/settings\.json$/);
  expect(errors).toEqual([]);
});

test("settings JSON offers project and language completions with schema downloads disabled", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  const response = await page.request.get("/schemas/settings.v1.schema.json");
  expect(response.ok()).toBe(true);
  expect((await response.json()).properties["editor.tabSize"].minimum).toBe(1);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    const current = await app.runtime.request("settings.read");
    await app.runtime.request("settings.patch", { changes: [{ scope: "user", path: ["project.schemas"], before: current.layers.user["project.schemas"], value: { catalog: false, download: false } }] });
    const file = ".config/oxbit/settings.local.json";
    for (const path of [".config", ".config/oxbit"]) {
      try { await app.runtime.request("fs.mkdir", { path }); }
      catch (error) { if (!String(error).includes("EEXIST")) throw error; }
    }
    await app.runtime.request("fs.write", { path: file, text: '{\n  "project.intelligence": {},\n  "[mdx]": {"editor.wordWrap": "on"}\n}', expectedRevision: null });
    await app.openFile(file);
    await app.kernel.services.get("language").serviceForPath(file).start(true);
    const view = app.workbench.activeEditor();
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("{}") + 1 } }); view.focus();
  });
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("maxFiles");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("maxFileBytes");
  await page.screenshot({ path: "evidence/settings-files/schema-completion.png" });
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const view = (window as any).__oxbit.workbench.activeEditor();
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('"on"') + 1 } }); view.focus();
  });
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("bounded");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const view = (window as any).__oxbit.workbench.activeEditor();
    view.dispatch({ changes: { from: view.state.doc.length - 1, insert: ', "editor.tabSize": "bad"\n' } });
  });
  await expect.poll(() => page.evaluate(() => ((window as any).__oxbit.kernel.services.get("language").diagnostics.get(".config/oxbit/settings.local.json") ?? []).some((item: any) => item.message.includes("number")))).toBe(true);
  expect(errors).toEqual([]);
});

test("a settings UI change saves over a value that changed on disk, and User scope reaches the user file", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  const original = await page.evaluate(async () => {
    const app = (window as any).__oxbit, notify = app.workbench.notify.bind(app.workbench), notices: string[] = (window as any).__notices = [];
    app.workbench.notify = (message: string, ...rest: unknown[]) => { notices.push(message); return notify(message, ...rest); };
    for (const path of [".config", ".config/oxbit"]) {
      try { await app.runtime.request("fs.mkdir", { path }); }
      catch (error) { if (!String(error).includes("EEXIST")) throw error; }
    }
    // A Workspace reset only clears the active file, so drop the shared file's value from the first test.
    const shared = await app.runtime.request("fs.read", { path: ".config/oxbit/settings.json" }).catch(() => undefined);
    if (shared) {
      const { "editor.tabSize": _, ...rest } = JSON.parse(shared.text);
      await app.runtime.request("fs.write", { path: shared.path, text: JSON.stringify(rest), expectedRevision: shared.revision });
    }
    const file = await app.runtime.request("fs.read", { path: ".config/oxbit/settings.local.json" }).catch(() => undefined);
    await app.runtime.request("fs.write", { path: ".config/oxbit/settings.local.json", text: '{"editor.tabSize":5}', expectedRevision: file?.revision ?? null });
    return (await app.runtime.request("settings.read")).layers.user["editor.tabSize"];
  });
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.tabSize"))).toBe(5);
  // The UI edit is sent with the old value before the runtime reports the disk change; the client saves it over the new value.
  await page.evaluate(async () => {
    const app = (window as any).__oxbit, file = await app.runtime.request("fs.read", { path: ".config/oxbit/settings.local.json" });
    await app.runtime.request("fs.write", { path: file.path, text: '{"editor.tabSize":9}', expectedRevision: file.revision });
    app.kernel.configuration.set("editor.tabSize", 7, "workspace"); await app.kernel.configuration.flush();
  });
  const local = () => page.evaluate(async () => JSON.parse((await (window as any).__oxbit.runtime.request("fs.read", { path: ".config/oxbit/settings.local.json" })).text));
  await expect.poll(local).toEqual({ "editor.tabSize": 7 });
  await page.evaluate(() => (window as any).__oxbit.kernel.commands.execute("settings.open"));
  await page.getByRole("textbox", { name: "Search settings" }).fill("editor.tabSize");
  const input = page.locator('input[type="number"]');
  await expect(page.getByRole("button", { name: "User", exact: true })).toHaveAttribute("aria-pressed", "true");
  const note = page.locator('[data-setting-id="editor.tabSize"]').getByRole("note");
  await expect(note).toHaveText("The Workspace value 7 overrides this setting. Remove Workspace value");
  await input.fill("3"); await input.blur();
  await expect.poll(() => page.evaluate(async () => (await (window as any).__oxbit.runtime.request("settings.read")).layers.user["editor.tabSize"])).toBe(3);
  await note.getByRole("button", { name: "Remove Workspace value" }).click();
  await expect(note).toHaveCount(0);
  await expect.poll(local).toEqual({});
  expect(await page.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.tabSize"))).toBe(3);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit, file = await app.runtime.request("fs.read", { path: ".config/oxbit/settings.local.json" });
    await app.runtime.request("fs.write", { path: file.path, text: '{"editor.tabSize":6,"editor.wordWrap":"on"}', expectedRevision: file.revision });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.wordWrap"))).toBe("on");
  expect(await page.evaluate(() => (window as any).__oxbit.kernel.configuration.get("editor.tabSize"))).toBe(6);
  expect(await page.evaluate(() => (window as any).__notices.filter((message: string) => message.includes("changed on disk")))).toEqual([]);
  await page.evaluate(async (value) => {
    const app = (window as any).__oxbit, file = await app.runtime.request("fs.read", { path: ".config/oxbit/settings.local.json" });
    await app.runtime.request("fs.delete", { path: file.path, expectedRevision: file.revision });
    await app.runtime.request("settings.patch", { changes: [{ scope: "user", path: ["editor.tabSize"], before: 3, ...(value === undefined ? {} : { value }) }] });
  }, original);
  expect(errors).toEqual([]);
});
