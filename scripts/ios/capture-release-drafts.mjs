import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { webkit, chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sample = join(root, "design/releases/v0.3.1/sample-workspace/Fieldnotes");
const output = join(root, "design/releases/v0.3.1/draft-captures");
const appRoot = "/device/Documents/Fieldnotes";
const sizes = [
  { name: "iphone", width: 440, height: 956, scale: 3 },
  { name: "ipad", width: 1032, height: 1376, scale: 2 },
];
const states = ["01-editor", "02-files", "03-html-preview", "04-markdown", "05-panels"];

async function sampleFiles(directory = sample) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await sampleFiles(path));
    else files[relative(sample, path).replaceAll("\\", "/")] = await readFile(path, "utf8");
  }
  return files;
}

function listings(files) {
  const paths = Object.keys(files);
  const directories = new Set([""]);
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  return Object.fromEntries([...directories].map(directory => {
    const prefix = directory ? directory + "/" : "";
    const children = new Map();
    for (const path of [...directories, ...paths]) {
      if (!path.startsWith(prefix) || path === directory) continue;
      const tail = path.slice(prefix.length);
      if (tail.includes("/")) continue;
      children.set(path, { path, name: tail, kind: directories.has(path) ? "directory" : "file" });
    }
    return [directory, [...children.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1))];
  }));
}

async function seedBridge(page, files, tree) {
  await page.addInitScript(({ files, tree, appRoot }) => {
    const storage = new Map();
    const opened = new Set();
    const recents = [{ id: "documents:Fieldnotes", kind: "documents", name: "Fieldnotes", directory: "Fieldnotes", lastOpened: Date.now() }];
    storage.set("session:recents", recents);
    storage.set("session:last-workspace", "documents:Fieldnotes");
    let callback = 0;
    const bridge = {
      transformCallback: () => ++callback,
      async invoke(command, args = {}) {
        if (command === "plugin:event|listen") return ++callback;
        if (command === "plugin:event|unlisten") return;
        if (command === "ios_documents_path") return "/device/Documents";
        if (command === "ios_storage_get") return storage.get(`${args.scope}:${args.key}`) ?? null;
        if (command === "ios_storage_set") { storage.set(`${args.scope}:${args.key}`, args.value); return; }
        if (command === "ios_icon_packs_read") return [];
        if (command === "ios_icon_packs_mutate") return;
        if (command === "ios_fs_open_root") {
          if (args.path !== appRoot) throw new Error(`Unexpected root: ${args.path}`);
          opened.add(appRoot);
          return { id: "ios:release-draft-fieldnotes", root: appRoot, name: "Fieldnotes" };
        }
        if (command === "ios_fs_close_root") { opened.delete(appRoot); return; }
        if (command === "ios_fs_watch" || command === "ios_fs_unwatch") return;
        if (command === "ios_fs_list") {
          if (!opened.size) throw { code: "ROOT_CLOSED", message: "Workspace root is closed" };
          return tree[args.path] ?? [];
        }
        if (command === "ios_fs_read") {
          if (!opened.size) throw { code: "ROOT_CLOSED", message: "Workspace root is closed" };
          if (!Object.hasOwn(files, args.path)) throw { code: "NOT_FOUND", message: "File not found" };
          return new TextEncoder().encode(files[args.path]).buffer;
        }
        if (command === "ios_lsp_message") return { payload: JSON.stringify({ result: args.method === "initialize" ? { capabilities: { textDocumentSync: 1 } } : null, notifications: [] }) };
        if (command === "ios_git_request") throw { code: "NOT_REPOSITORY", message: "Not a Git repository" };
        if (command === "ios_open_external") throw new Error("External navigation is disabled for release drafts");
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
    Object.assign(window, { __TAURI_INTERNALS__: bridge, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} } });
  }, { files, tree, appRoot });
}

async function openExplorer(page) {
  const explorer = page.getByRole("button", { name: "Explorer", exact: true });
  if (await explorer.getAttribute("aria-pressed") !== "true") await explorer.click();
  await expect(page.getByRole("treeitem").first()).toBeVisible();
}

async function openFile(page, name, folder) {
  await openExplorer(page);
  if (folder) {
    const directory = page.getByRole("treeitem").filter({ hasText: folder }).first();
    if (await directory.getAttribute("aria-expanded") !== "true") await directory.click();
  }
  await page.getByRole("treeitem").filter({ hasText: name }).first().click();
  await expect(page.locator(".editor-tab.active")).toContainText(name);
}

async function capture(page, size, state) {
  const path = join(output, size.name, state + ".png");
  await page.screenshot({ path, animations: "disabled" });
  return { path: relative(output, path), state, width: size.width * size.scale, height: size.height * size.scale };
}

async function runDevice(browser, size, files, tree, serverUrl) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await context.route("**/*", route => {
    const url = route.request().url();
    if (url.startsWith(serverUrl) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    external.push(url);
    return route.abort();
  });
  await seedBridge(page, files, tree);
  await page.goto(serverUrl);
  await expect(page.locator(".workspace-title")).toHaveText("Fieldnotes");
  await expect(page.locator(".workbench")).toHaveAttribute("data-mode", size.name === "iphone" ? "phone" : "tablet");
  const captures = [];

  await openFile(page, "journal.ts", "src");
  await expect(page.locator(".cm-content")).toContainText("findMoments");
  captures.push(await capture(page, size, states[0]));

  await openExplorer(page);
  const assets = page.getByRole("treeitem").filter({ hasText: "assets" }).first();
  if (await assets.getAttribute("aria-expanded") !== "true") await assets.click();
  await expect(page.getByRole("treeitem").filter({ hasText: "coast.svg" })).toBeVisible();
  captures.push(await capture(page, size, states[1]));

  await openFile(page, "index.html");
  await page.getByRole("button", { name: "Open HTML preview", exact: true }).click();
  const html = page.frameLocator('iframe[title="HTML preview"]');
  await expect(html.getByRole("heading", { name: /A little more/ })).toBeVisible();
  await expect(page.locator(".html-document")).toHaveAttribute("aria-busy", "false");
  captures.push(await capture(page, size, states[2]));

  await openFile(page, "README.md");
  await page.getByRole("button", { name: "Open Markdown preview", exact: true }).click();
  await expect(page.getByRole("article", { name: "Markdown preview" }).getByRole("heading", { name: "Fieldnotes" })).toBeVisible();
  captures.push(await capture(page, size, states[3]));

  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Panels", exact: true })).toBeVisible();
  captures.push(await capture(page, size, states[4]));
  if (errors.length || external.length) throw new Error(JSON.stringify({ size: size.name, errors, external }));
  await context.close();
  return captures;
}

const files = await sampleFiles();
const tree = listings(files);
await mkdir(output, { recursive: true });
for (const size of sizes) await mkdir(join(output, size.name), { recursive: true });
const server = await createServer({ root: join(root, "apps/ios"), configFile: join(root, "apps/ios/vite.config.ts"), server: { host: "127.0.0.1", port: 9281, strictPort: true } });
let browser;
let browserEngine = "webkit";
try {
  await server.listen();
  try { browser = await webkit.launch({ headless: true }); }
  catch { browserEngine = "chromium"; browser = await chromium.launch({ headless: true }); }
  const url = "http://127.0.0.1:9281/";
  const captures = [];
  for (const size of sizes) captures.push(...await runDevice(browser, size, files, tree, url));
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const sourceHash = createHash("sha256").update(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => `${path}\0${content}\0`).join("")).digest("hex");
  const frontendHash = createHash("sha256");
  for (const path of ["apps/ios/src/main.tsx", "apps/ios/src/ios.css"]) {
    frontendHash.update(path).update("\0").update(await readFile(join(root, path))).update("\0");
  }
  await writeFile(join(output, "provenance.json"), JSON.stringify({
    kind: "browser-draft", nativeCapture: false, generatedAt: new Date().toISOString(),
    sourceHead, frontendSha256: frontendHash.digest("hex"), sampleSha256: sourceHash,
    frontend: "apps/ios/src/main.tsx", bridge: "test-only Tauri filesystem and persistence bridge",
    browserEngine, browserVersion: browser.version(), devices: sizes.map(({ name, width, height, scale }) => ({ name, viewport: [width, height], deviceScaleFactor: scale })), captures,
  }, null, 2) + "\n");
  console.log(`Captured ${captures.length} ${browserEngine} browser drafts in ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
