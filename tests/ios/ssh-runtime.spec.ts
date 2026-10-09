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
