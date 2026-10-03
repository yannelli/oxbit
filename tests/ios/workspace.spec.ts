import { expect, test } from "@playwright/test";

test("switching iOS workspaces replaces panels before disposing the old session", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => {
    const storage = new Map<string, unknown>();
    const roots = new Set<string>();
    const packs = new Map<string, unknown>();
    const closed: { id: string; title: string | null | undefined }[] = [];
    let callback = 0;
    let opened = 0;
    const files = ["example.ts", "settings.jsonc"];
    const bridge = {
      transformCallback: () => ++callback,
      async invoke(command: string, args: any = {}) {
        if (command === "plugin:event|listen") return ++callback;
        if (command === "plugin:event|unlisten") return;
        if (command === "ios_documents_path") return "/device/Documents";
        if (command === "plugin:oxbit-files|pick_folder")
          return { id: "second", name: "Second", path: "/device/Second", stale: false };
        if (command === "plugin:oxbit-files|close_folder") return;
        if (command === "ios_storage_get") return storage.get(`${args.scope}:${args.key}`) ?? null;
        if (command === "ios_storage_set") { storage.set(`${args.scope}:${args.key}`, args.value); return; }
        if (command === "ios_icon_packs_read") return [...packs.values()];
        if (command === "ios_icon_packs_mutate") { packs.set(args.id, args.pack); return; }
        if (command === "ios_fs_open_root") {
          opened++;
          roots.add(args.path);
          return { id: args.path, root: args.path, name: args.path.split("/").at(-1) };
        }
        if (command === "ios_fs_close_root") {
          closed.push({ id: args.id, title: document.querySelector(".workspace-title")?.textContent });
          roots.delete(args.id);
          return;
        }
        if (command === "ios_fs_watch" || command === "ios_fs_unwatch") return;
        if (command === "ios_fs_list") {
          if (!roots.has(args.id)) throw { code: "ROOT_CLOSED", message: "Workspace root is not open" };
          return args.path ? [] : files.map(path => ({ path, name: path, kind: "file" }));
        }
        if (command === "ios_fs_read") {
          if (!roots.has(args.id)) throw { code: "ROOT_CLOSED", message: "Workspace root is not open" };
          if (!files.includes(args.path)) throw { code: "NOT_FOUND", message: "File not found" };
          const text = args.path === "settings.jsonc" ? '// Keep comments\n{"enabled":true}' : 'const workspace = "' + args.id + '";\n';
          return new TextEncoder().encode(text).buffer;
        }
        if (command === "ios_lsp_message") {
          if (args.method !== "exit" && !roots.has(args.workspaceId)) throw { code: "ROOT_CLOSED", message: "Workspace root is not open" };
          return { payload: JSON.stringify({ result: args.method === "initialize" ? { capabilities: { textDocumentSync: 1 } } : null, notifications: [] }) };
        }
        if (command === "ios_git_request") throw { code: "NOT_REPOSITORY", message: "Not a git repository" };
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: bridge,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __iosTest: { closed, get opened() { return opened; } },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.locator(".cm-content")).toContainText("/device/Documents");
  await expect(page.getByRole("button", { name: "Language Servers: 1 running" })).toBeVisible();

  await page.locator(".workspace-title").click();
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.getByRole("dialog", { name: "Workspaces" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__iosTest.opened)).toBe(1);

  await page.locator(".workspace-title").click();
  await page.getByRole("button", { name: "Open Folder…", exact: true }).click();
  await expect(page.locator(".workspace-title")).toHaveText("Second");
  await expect(page.locator(".cm-content")).toContainText("/device/Second");
  await expect(page.getByRole("button", { name: "Language Servers: 1 running" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__iosTest.closed)).toEqual([
    { id: "/device/Documents", title: "Second" },
  ]);
  await page.getByRole("button", { name: "Language Servers: 1 running" }).click();
  await expect(page.getByRole("dialog", { name: "Language Servers", exact: true })).toContainText("Language intelligence is active");
  await page.getByRole("button", { name: "Close Language Servers" }).click();
  await page.screenshot({ path: "evidence/ios-language/workspace-switched.png" });
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await page.getByText("settings.jsonc", { exact: true }).click();
  await page.getByRole("button", { name: "Editor actions", exact: true }).click();
  const format = page.getByRole("menuitem", { name: "Format Document", exact: true });
  await expect(format).toBeEnabled();
  await format.click();
  await expect(page.locator(".cm-content")).toContainText('{ "enabled": true }');
  await expect(page.locator(".cm-content")).toContainText("// Keep comments");
  await page.screenshot({ path: "evidence/ios-language/jsonc-formatted.png" });
  expect(errors).toEqual([]);
});
