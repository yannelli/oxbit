import { expect, test, type Page } from "@playwright/test";
import { installBridge } from "./bridge.js";
import { installSshBridge, PRESENTED, RUNTIME_URL, type SshSeed } from "./ssh-bridge.js";

const OUT = process.env.OXBIT_SSH_SCREENSHOTS ?? "evidence/ios-ssh";
const key = { id: "key-1", name: "Phone", algorithm: "ssh-ed25519", fingerprint: "SHA256:Zq0c7Qm4l7gK3qGxw0b3m8R3pYk9uTn2vL6hJd1sFfE", publicKey: "ssh-ed25519 AAAAC3Nza phone@oxbit-ios" };
const host = { id: "host-1", label: "Build box", hostname: "build.example.test", port: 22, username: "dev", auth: "key" as const, keyId: "key-1", passwordSaved: false };
const seed: SshSeed = { hosts: [host], keys: [key], known: { "host-1": [{ ...PRESENTED, added: 1 }] } };

/** Answers the runtime protocol the way a remote `desktop.js` does for an empty project. */
async function mockRuntime(page: Page) {
  const methods: string[] = [];
  await page.routeWebSocket(RUNTIME_URL.replace("http", "ws") + "/ws", socket => {
    socket.onMessage(message => {
      const request = JSON.parse(String(message));
      methods.push(request.method);
      const result = request.method === "auth.authenticate"
        ? { workspaceId: "default", capabilities: ["files", "terminal", "tasks", "agents"], trusted: false, owner: true, workspaceKey: "a".repeat(64), workspaceName: "project" }
        : request.method === "fs.list" ? [{ path: "hello.ts", name: "hello.ts", kind: "file" }]
          : request.method.endsWith(".list") ? [] : {};
      socket.send(JSON.stringify({ v: 1, type: "response", id: request.id, result }));
    });
  });
  return methods;
}

async function start(page: Page, overrides: SshSeed = {}) {
  await installBridge(page);
  await installSshBridge(page, { ...seed, ...overrides });
  const methods = await mockRuntime(page);
  await page.goto("/");
  return methods;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}-393x852.png`, animations: "disabled" });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.screenshot({ path: `${OUT}/${name}-320x700.png`, animations: "disabled" });
  await page.setViewportSize({ width: 393, height: 852 });
}

async function topmost(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
}

const calls = (page: Page) => page.evaluate(() => (window as any).__sshMock.calls as string[]);
const release = (page: Page) => page.evaluate(() => (window as any).__sshMock.release());

async function openDialog(page: Page) {
  await page.getByRole("button", { name: "Start Oxbit on This Server…", exact: true }).click();
  expect(await topmost(page, "Start Oxbit on This Server")).toBe(true);
}

test("Start Oxbit on This Server shows the desktop progress, opens the workspace, and stops it on close", async ({ page }) => {
  const methods = await start(page);
  await openDialog(page);
  await expect(page.getByRole("textbox", { name: "Remote folder" })).toHaveValue("~");
  for (const control of [page.getByRole("button", { name: "Start", exact: true }), page.getByRole("combobox", { name: "Server" })])
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await shoot(page, "runtime-start");

  await page.getByRole("textbox", { name: "Remote folder" }).fill("project");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Installing the remote runtime…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Starting…", exact: true })).toBeDisabled();
  await shoot(page, "runtime-installing");
  await release(page);

  await expect(page.locator(".workspace-title")).toHaveText("Build box: project");
  expect(await calls(page)).toEqual(expect.arrayContaining(["ios_ssh_connect", "ios_ssh_runtime_start"]));
  expect(methods[0]).toBe("auth.authenticate");
  expect(methods).toContain("fs.list");

  await page.locator(".workspace-title").click();
  const entry = page.getByRole("region", { name: "On a server" }).getByRole("button", { name: /^Build box: project/ });
  await expect(entry).toContainText("Oxbit runtime · /home/dev/project");
  expect((await entry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await shoot(page, "runtime-recent");

  await openDialog(page);
  await expect(page.getByRole("textbox", { name: "Remote folder" })).toHaveValue("/home/dev/project");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: /^Oxbit/ }).first().click();
  await expect(page.locator(".workspace-title")).toHaveText("Oxbit");
  await expect.poll(() => calls(page)).toContain("ios_ssh_runtime_stop");
});

test("A failed start keeps the dialog open with the error and stops the runtime", async ({ page }) => {
  await start(page, { runtimeFailure: "Remote SSH supports Linux x64 and arm64 (glibc) and macOS Apple Silicon." });
  await openDialog(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Installing the remote runtime…" })).toBeVisible();
  await release(page);
  const dialog = page.getByRole("dialog", { name: "Start Oxbit on This Server", exact: true });
  await expect(dialog.getByRole("alert")).toHaveText("Remote SSH supports Linux x64 and arm64 (glibc) and macOS Apple Silicon.");
  await expect.poll(() => calls(page)).toContain("ios_ssh_runtime_stop");
  await shoot(page, "runtime-error");
});

const starts = (page: Page) => page.evaluate(() => (window as any).__sshMock.starts as { path: string; root: string; workspaceKey: string }[]);
const stored = (page: Page, key: string) => page.evaluate(key => (window as any).__iosTest.storage.get(key), key);

async function startProject(page: Page) {
  await openDialog(page);
  await page.getByRole("textbox", { name: "Remote folder" }).fill("project");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Installing the remote runtime…" })).toBeVisible();
  await release(page);
  await expect(page.locator(".workspace-title")).toHaveText("Build box: project");
}

test("Relaunching the app reopens the remote runtime with the same workspace key and recent", async ({ page, context }) => {
  await start(page);
  await startProject(page);
  const [first] = await starts(page);
  const recents = await stored(page, "session:recents");
  const last = await stored(page, "session:last-workspace");
  expect(last).toBe(`sshRuntime:${first!.workspaceKey}`);
  await page.close();

  const relaunched = await context.newPage();
  await installBridge(relaunched, { stored: { "session:recents": recents, "session:last-workspace": last } });
  await installSshBridge(relaunched, seed);
  await mockRuntime(relaunched);
  await relaunched.goto("/");
  await expect(relaunched.getByRole("status").filter({ hasText: "Installing the remote runtime…" })).toBeVisible();
  await release(relaunched);
  await expect(relaunched.locator(".workspace-title")).toHaveText("Build box: project");
  const [again] = await starts(relaunched);
  expect(again).toMatchObject({ path: "/home/dev/project", root: "/home/dev/project", workspaceKey: first!.workspaceKey });
  const after = (await stored(relaunched, "session:recents")) as { id: string; kind: string }[];
  expect(after.filter(recent => recent.kind === "sshRuntime").map(recent => recent.id)).toEqual([last]);
});

test("A dropped remote runtime offers Reconnect", async ({ page }) => {
  await start(page);
  await startProject(page);
  await page.evaluate(() => (window as any).__sshMock.runtimeEvent({ state: "failed", message: "Could not connect to build.example.test:22" }));
  await page.evaluate(() => (window as any).__sshMock.runtimeEvent({ state: "failed", message: "Oxbit stopped reconnecting to the server after repeated failures. Reconnect to retry." }));
  const notice = page.locator(".notification.error", { hasText: "Oxbit stopped reconnecting" });
  await expect(notice).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll(".notification.error").length)).toBe(1);
  await notice.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => calls(page)).toContain("ios_ssh_runtime_resume");
  await page.evaluate(() => (window as any).__sshMock.runtimeEvent({ state: "running" }));
  await expect(notice).toHaveCount(0);
  await expect(page.locator(".notification", { hasText: "Reconnected to the remote workspace." })).toBeVisible();
});

test("The runtime button in an SFTP folder starts Oxbit in that folder", async ({ page }) => {
  await installBridge(page, {
    stored: { "session:recents": [{ id: "runtime:laptop", kind: "runtime", name: "laptop", url: "http://127.0.0.1:2", lastOpened: 1 }] },
  });
  await installSshBridge(page, seed);
  await mockRuntime(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect with SSH…", exact: true }).click();
  await page.getByRole("textbox", { name: "Remote folder" }).fill("project");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".workspace-title")).toHaveText("Build box: project");

  await page.getByRole("button", { name: "Runtime connection", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Start Oxbit on This Server", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Remote folder" })).toHaveValue("/home/dev/project");
  await expect(dialog.getByRole("status").filter({ hasText: "Installing the remote runtime…" })).toBeVisible();
  await release(page);
  await expect(page.locator(".workspace-title")).toHaveText("Build box: project");
  expect((await starts(page)).map(started => started.path)).toEqual(["/home/dev/project"]);
  expect(await page.evaluate(() => (window as any).__iosTest.runtimeRequests)).toEqual([]);
});

test("Browse Folders picks a folder, sets the home folder, and Switch Folder moves the runtime", async ({ page }) => {
  await start(page);
  await openDialog(page);
  await page.getByRole("button", { name: "Browse Folders…", exact: true }).click();
  const browser = page.getByRole("dialog", { name: "Choose a Folder", exact: true });
  await expect(browser.getByLabel("Current folder")).toHaveText("/home/dev");
  const folders = browser.getByRole("list", { name: "Folders" });
  await expect(folders.getByRole("button")).toHaveText(["other", "project"]);
  expect((await folders.getByRole("button", { name: "project" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await browser.getByRole("button", { name: "Up", exact: true }).click();
  await expect(browser.getByLabel("Current folder")).toHaveText("/home");
  await folders.getByRole("button", { name: "dev" }).click();
  await folders.getByRole("button", { name: "project" }).click();
  await expect(browser.getByLabel("Current folder")).toHaveText("/home/dev/project");
  await browser.getByRole("button", { name: "Set as Home Folder", exact: true }).click();
  await expect(browser.getByRole("status")).toHaveText("/home/dev/project is the home folder for this server.");
  expect(await stored(page, "session:ssh-home-folders")).toEqual({ "host-1": "/home/dev/project" });
  await shoot(page, "runtime-browse");
  await browser.getByRole("button", { name: "Use This Folder", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Installing the remote runtime…" })).toBeVisible();
  await release(page);
  await expect(page.locator(".workspace-title")).toHaveText("Build box: project");

  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByRole("dialog", { name: "Quick Open" });
  await palette.getByRole("combobox").fill(">Switch Folder");
  await palette.getByRole("option", { name: /Switch Folder/ }).click();
  await expect(browser.getByLabel("Current folder")).toHaveText("/home/dev/project");
  await browser.getByRole("button", { name: "Up", exact: true }).click();
  await folders.getByRole("button", { name: "other" }).click();
  await browser.getByRole("button", { name: "Use This Folder", exact: true }).click();
  await expect.poll(() => calls(page)).toContain("ios_ssh_runtime_stop");
  await expect(page.getByRole("status").filter({ hasText: "Installing the remote runtime…" })).toBeVisible();
  await release(page);
  await expect(page.locator(".workspace-title")).toHaveText("Build box: other");
  expect((await starts(page)).map(started => started.path)).toEqual(["/home/dev/project", "/home/dev/other"]);

  await page.locator(".workspace-title").click();
  await openDialog(page);
  await expect(page.getByRole("textbox", { name: "Remote folder" })).toHaveValue("/home/dev/project");
});
