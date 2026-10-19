import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { webkit, chromium, expect } from "@playwright/test";
import { installBridge } from "../../tests/ios/bridge.ts";
import { installSshBridge } from "../../tests/ios/ssh-bridge.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const release = join(root, "design/releases/v0.13.0");
const sample = join(release, "sample-workspace/Fieldnotes");
const output = join(release, "captures");
const workspaceRoot = "/device/Documents/Fieldnotes";
/** Viewports leave out the status bar and home indicator insets; render-store-assets.mjs draws both. */
export const devices = [
  { name: "iphone", width: 440, height: 956, scale: 3, insets: { top: 62, bottom: 34 } },
  { name: "iphone-6.3", width: 402, height: 874, scale: 3, insets: { top: 62, bottom: 34 } },
  { name: "ipad", width: 1032, height: 1376, scale: 2, insets: { top: 24, bottom: 20 } },
];
const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7);
const openrouter = "openai-compatible https://openrouter.ai";
const day = Date.UTC(2026, 9, 19, 16, 41);
const fieldnotes = { id: "documents:Fieldnotes", kind: "documents", name: "Fieldnotes", directory: "Fieldnotes", lastOpened: day };
const sse = text => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n",
];
const toolCall = (id, name, args) => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`, "data: [DONE]\n\n",
];

async function sampleFiles(directory = sample) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await sampleFiles(path));
    else if (entry.name !== ".DS_Store") files[relative(sample, path)] = await readFile(path, "utf8");
  }
  return files;
}
function listings(files) {
  const directories = new Set([""]);
  for (const path of Object.keys(files)) path.split("/").slice(0, -1).forEach((_, i, parts) => directories.add(parts.slice(0, i + 1).join("/")));
  const entries = [...[...directories].filter(Boolean).map(path => ({ path, kind: "directory" })), ...Object.keys(files).map(path => ({ path, kind: "file" }))];
  return Object.fromEntries([...directories].map(directory => [directory, entries
    .filter(entry => entry.path.split("/").slice(0, -1).join("/") === directory)
    .map(entry => ({ ...entry, name: entry.path.split("/").at(-1) }))
    .sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1)]));
}
/** Serves Fieldnotes and a scripted repository on top of tests/ios/bridge.ts. */
async function installFieldnotes(page, files, git) {
  await page.addInitScript(({ files, tree, workspaceRoot, git }) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args = {}, options) => {
      if (command === "ios_fs_list" && args.id === workspaceRoot) return tree[args.path] ?? [];
      if (command === "ios_fs_read" && args.id === workspaceRoot) {
        if (!Object.hasOwn(files, args.path)) throw { code: "NOT_FOUND", message: "File not found" };
        return new TextEncoder().encode(files[args.path]).buffer;
      }
      if (command === "ios_fs_write" && options?.headers?.["x-oxbit-root"] === workspaceRoot) {
        files[decodeURIComponent(options.headers["x-oxbit-path"])] = new TextDecoder().decode(args);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", args));
        return { revision: [...digest].map(byte => byte.toString(16).padStart(2, "0")).join(""), size: args.byteLength };
      }
      if (command === "ios_git_request" && git) return args.method === "diff" ? { before: git.before[args.params.path] ?? "", after: files[args.params.path] ?? "" } : git[args.method] ?? [];
      return invoke(command, args, options);
    };
  }, { files, tree: listings(files), workspaceRoot, git });
}

const repository = {
  status: {
    repository: true, head: "4f2c9a1d7be0", branch: "main", upstream: "origin/main", branches: ["main", "photo-grid"], refs: [],
    changes: [
      { path: "src/journal.ts", index: " ", working: "M" },
      { path: "styles.css", index: " ", working: "M" },
      { path: "index.html", index: "M", working: " " },
      { path: "src/moments.ts", index: "?", working: "?" },
    ],
    remotes: [{ name: "origin", fetchUrl: "https://git.example.com/fieldnotes.git", pushUrl: "https://git.example.com/fieldnotes.git" }], ahead: 1, behind: 0,
  },
  log: { commits: [
    { id: "4f2c9a1d7be0", parents: ["9b31e07c55aa"], author: "Sam Rivera", date: "2026-10-18T19:12:00Z", subject: "Add the coast illustration", body: "", refs: "HEAD -> main" },
    { id: "9b31e07c55aa", parents: [], author: "Sam Rivera", date: "2026-10-17T15:40:00Z", subject: "Start the Fieldnotes journal", body: "", refs: "origin/main" },
  ], hasMore: false },
  stashes: [],
};

async function openFile(page, path) {
  await page.evaluate(path => window.__oxbit.workbench.openFile(path), path);
  await expect(page.locator(".editor-tab.active", { hasText: path.split("/").at(-1) }).first()).toBeVisible();
}

async function configure(page, settings) {
  await page.evaluate(async settings => {
    for (const [id, value] of Object.entries(settings)) await window.__oxbit.kernel.configuration.set(id, value, "user");
  }, settings);
}

const screens = [
  {
    id: "01-ai-completion",
    bridge: { agentKeys: [openrouter], agentResponses: { "/v1/chat/completions": { chunks: sse("entries\n    .filter((entry) => entry.tags.includes(tag))\n    .map((entry) => entry.place);"), delay: 40 } } },
    async run(page, device) {
      await configure(page, { "ai.provider": "openrouter", "ai.model": "openai/gpt-6-luna", "ai.inlineCompletions.enabled": true, "ai.inlineCompletions.delay": 120, "editor.wordWrap": "on", ...(device.name === "iphone-6.3" && { "editor.fontSize": 12 }) });
      if (device.name === "ipad") {
        await openFile(page, "README.md");
        await page.evaluate(() => window.__oxbit.workbench.run("preview.markdownSide"));
        await expect(page.getByRole("article", { name: "Markdown preview" })).toBeVisible();
        await page.locator(".editor-group").first().locator(".cm-content").click();
      }
      await openFile(page, "src/journal.ts");
      await page.locator(".cm-content[contenteditable=true]").first().click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("\nexport function placesFor(tag: string): string[] {\nreturn ");
      await expect(page.locator(".cm-ai-ghost")).toContainText("entry.place");
      await page.locator(".cm-scroller").evaluate(element => {
        Object.assign(element, { scrollLeft: 0, scrollTop: element.scrollHeight });
        const top = element.getBoundingClientRect().top, line = [...element.querySelectorAll(".cm-line")].find(item => item.getBoundingClientRect().bottom > top);
        element.scrollTop -= Math.max(0, top - line.getBoundingClientRect().top);
        if (element.querySelector(".cm-ai-ghost").getBoundingClientRect().bottom > element.getBoundingClientRect().bottom) throw new Error("The ghost text runs past the editor.");
      });
    },
  },
  {
    id: "02-agent",
    bridge: { agentKeys: [openrouter], agentResponses: {
      "/v1/models": { chunks: [JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-5.5" }] })] },
      "/v1/chat/completions": [
        { chunks: toolCall("call_1", "read_file", { path: "src/journal.ts" }) },
        { chunks: toolCall("call_2", "edit_file", { path: "README.md", old_string: "## Notes from the road", new_string: "## Coast entries\n\n- Harbor walk: The sky turned the water to silver.\n\n## Notes from the road" }) },
        { chunks: sse("Harbor walk is the only entry tagged `coast`. I added a **Coast entries** section to README.md that quotes its moment.") },
        { chunks: sse("Coast entries in README") },
      ],
    } },
    async run(page) {
      await configure(page, { "agentACP.oxbit.api": "openai-compatible", "agentACP.oxbit.baseUrl": "https://openrouter.ai/api", "agentACP.oxbit.model": "anthropic/claude-sonnet-5.5" });
      await page.evaluate(async () => {
        await window.__oxbit.kernel.extensions.activate("oxbit.agent-acp");
        window.__oxbit.workbench.run("agentACP.open");
      });
      const panel = page.locator(".acp-panel:not(.acp-review-editor):not(.acp-agents-view)");
      await panel.getByRole("button", { name: "Start Oxbit Agent" }).click();
      const composer = panel.getByRole("textbox", { name: "Message agent" });
      await expect(composer).toBeEnabled();
      await composer.fill("Which journal entries mention the coast? List them in the README.");
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await panel.getByRole("button", { name: "Apply change", exact: true }).click();
      await expect(panel.getByText("is the only entry tagged")).toBeVisible();
      await expect(panel.getByText("Coast entries in README")).toBeVisible();
    },
  },
  {
    id: "03-ai-models",
    bridge: { agentKeys: [openrouter] },
    async run(page, device) {
      await configure(page, { "ai.provider": "openrouter", "ai.model": "openai/gpt-6-luna", "ai.inlineCompletions.enabled": true });
      await page.evaluate(() => window.__oxbit.workbench.run("settings.open"));
      await expect(page.getByRole("textbox", { name: "Search settings" })).toBeVisible();
      await page.getByRole("textbox", { name: "Search settings" }).fill("inline edits");
      await expect(page.getByRole("combobox", { name: "AI provider", exact: true })).toBeVisible();
      await page.getByRole("textbox", { name: "Search settings" }).blur();
      if (device.name !== "ipad") await page.getByRole("list", { name: "Suggestions for AI model" }).evaluate(list => {
        let scroller = list.parentElement;
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
        const align = (element, margin) => { scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - margin; };
        align([...document.querySelectorAll("button,select,[role=combobox]")].find(item => item.textContent.trim() === "All languages"), 6);
        if (list.getBoundingClientRect().bottom > scroller.getBoundingClientRect().bottom)
          align([...scroller.querySelectorAll("*")].find(item => !item.children.length && item.textContent.trim() === "AI"), 8);
      });
      await expect(page.getByRole("list", { name: "Suggestions for AI model" }).getByRole("button").first()).toContainText("Mercury 2.5");
    },
  },
  {
    id: "04-source-control",
    bridge: { repository: true },
    git: repository,
    async run(page) {
      await openFile(page, "src/journal.ts");
      await page.getByRole("button", { name: "Source Control", exact: true }).click();
      await expect(page.getByText("moments.ts").first()).toBeVisible();
      await page.locator("textarea").first().fill("Add a coast section to the journal");
      await page.locator("textarea").first().blur();
    },
  },
  {
    id: "05-html-preview",
    async run(page, device) {
      await openFile(page, "index.html");
      await page.evaluate(command => window.__oxbit.workbench.run(command), device.name === "ipad" ? "preview.htmlSide" : "preview.html");
      await expect(page.frameLocator('iframe[title="HTML preview"]').getByRole("heading", { name: /A little more/ })).toBeVisible();
      if (device.name !== "ipad") for (const name of ["README.md", "index.html"]) await page.getByRole("button", { name: `Close ${name}`, exact: true }).tap();
      await expect(page.locator(".html-document")).toHaveAttribute("aria-busy", "false");
    },
  },
  {
    id: "06-workspaces",
    recents: [
      fieldnotes,
      { id: "bookmark:sketchbook", kind: "bookmark", name: "Sketchbook", lastOpened: day - 86400000 },
      { id: "runtime:studio", kind: "runtime", name: "studio", url: "http://studio.local:7420", runtimeId: "abc12345-0000-4000-8000-000000000001", lastOpened: day - 3600000 },
      { id: "sshRuntime:build", kind: "sshRuntime", name: "build-server: fieldnotes", hostId: "host-1", remotePath: "/home/sam/fieldnotes", lastOpened: day - 7200000 },
      { id: "ssh:build", kind: "ssh", name: "build-server: site", hostId: "host-1", remotePath: "/home/sam/site", lastOpened: day - 10800000 },
    ],
    ssh: { hosts: [{ id: "host-1", label: "build-server", hostname: "build-server.local", port: 22, username: "sam", auth: "key", keyId: "key-1", passwordSaved: false }] },
    async run(page) {
      await page.locator(".workspace-title").click();
      await expect(page.getByRole("dialog", { name: "Workspaces" })).toContainText("build-server: fieldnotes");
      await page.getByRole("dialog", { name: "Workspaces" }).getByText("/home/sam/site").evaluate(path => {
        let scroller = path.parentElement;
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
        const label = path.closest("button,li,div").getBoundingClientRect().bottom > (scroller?.getBoundingClientRect().bottom ?? Infinity) && [...scroller.querySelectorAll("*")].find(item => !item.children.length && /^on this device$/i.test(item.textContent.trim()));
        if (label) scroller.scrollTop += label.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
      });
    },
  },
];

async function runScreen(browser, device, screen, files, url) {
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height - device.insets.top - device.insets.bottom }, deviceScaleFactor: device.scale,
    isMobile: true, hasTouch: true, colorScheme: "dark", locale: "en-US", timezoneId: "America/New_York",
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", error => problems.push(error.message));
  page.on("console", message => { if (message.type() === "error") problems.push(message.text()); });
  await context.route("**/*", route => {
    const target = route.request().url();
    if (target.startsWith(url) || target.startsWith("data:") || target.startsWith("blob:")) return route.continue();
    problems.push(`external request: ${target}`);
    return route.abort();
  });
  const stored = { "session:recents": screen.recents ?? [fieldnotes], ...screen.start ? {} : { "session:last-workspace": fieldnotes.id } };
  await installBridge(page, { ...screen.bridge, stored });
  await installSshBridge(page, screen.ssh);
  await installFieldnotes(page, files, screen.git);
  await page.clock.setFixedTime(day);
  await page.goto(url);
  await page.addStyleTag({ content: "*::-webkit-scrollbar{display:none}" });
  if (!screen.start) {
    await expect(page.locator(".workspace-title")).toHaveText("Fieldnotes");
    await page.waitForFunction(() => window.__oxbit?.ready);
  }
  try { await screen.run(page, device); }
  catch (error) {
    await page.screenshot({ path: `/tmp/oxbit-store-${device.name}-${screen.id}.png` });
    console.error(problems, JSON.stringify(await page.evaluate(() => window.__iosTest.agentRequests.map(({ path, body }) => ({ path, body })))).slice(0, 4000));
    throw error;
  }
  const path = join(output, device.name, `${screen.id}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "initial" });
  await context.close();
  const consoleErrors = Object.entries(Object.groupBy(problems, text => text)).map(([message, list]) => ({ message, count: list.length }));
  if (consoleErrors.length) console.warn(`${device.name}/${screen.id}:`, consoleErrors);
  return { path: relative(release, path), state: screen.id, device: device.name, width: device.width * device.scale, height: (device.height - device.insets.top - device.insets.bottom) * device.scale, consoleErrors };
}

async function main() {
  const files = await sampleFiles();
  repository.before = {
    "src/journal.ts": files["src/journal.ts"].replace(/export function findMoments[\s\S]*$/, "export function findMoments(tag: string): JournalEntry[] {\n  return entries.filter((entry) => entry.tags.includes(tag));\n}\n"),
    "index.html": files["index.html"].replace("A JOURNAL FOR THE CURIOUS", "A TRAVEL JOURNAL"),
    "styles.css": files["styles.css"].replace(/letter-spacing: [^;]+;/, "letter-spacing: 0;"),
  };
  for (const device of devices) await mkdir(join(output, device.name), { recursive: true });
  const server = await createServer({ root: join(root, "apps/ios"), configFile: join(root, "apps/ios/vite.config.ts"), server: { host: "127.0.0.1", port: 9281, strictPort: true }, logLevel: "warn" });
  let browser, browserEngine = "webkit";
  try {
    await server.listen();
    try { browser = await webkit.launch({ headless: true }); }
    catch { browserEngine = "chromium"; browser = await chromium.launch({ headless: true }); }
    const url = "http://127.0.0.1:9281/";
    const captures = [];
    for (const device of devices) for (const screen of screens.filter(item => !only || item.id === only))
      captures.push(await runScreen(browser, device, screen, files, url));
    if (only) return;
    const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const sampleSha256 = createHash("sha256").update(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => `${path}\0${text}\0`).join("")).digest("hex");
    await writeFile(join(release, "provenance.json"), JSON.stringify({
      kind: "webkit-render", nativeCapture: false, generatedAt: new Date().toISOString(), sourceHead,
      version: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
      source: "WebKit renders of the iOS frontend (apps/ios) served by Vite, with the mocked Tauri bridge from tests/ios/bridge.ts and tests/ios/ssh-bridge.ts",
      sample: "sample-workspace/Fieldnotes", sampleSha256, browserEngine, browserVersion: browser.version(),
      devices: devices.map(({ name, width, height, scale, insets }) => ({ name, screen: [width, height], viewport: [width, height - insets.top - insets.bottom], deviceScaleFactor: scale, insets })),
      statusBar: "drawn by scripts/ios/render-store-assets.mjs: 9:41, Wi-Fi, full battery", injectedStyle: "*::-webkit-scrollbar{display:none} hides scroll indicators after scripted scrolling", captures,
    }, null, 2) + "\n");
    console.log(`Captured ${captures.length} ${browserEngine} screens in ${relative(root, output)}`);
  } finally {
    await browser?.close();
    await server.close();
  }
}

await main();
