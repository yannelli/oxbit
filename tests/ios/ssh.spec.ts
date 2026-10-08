import { expect, test, type Page } from "@playwright/test";
import { installBridge } from "./bridge.js";
import { installSshBridge, PRESENTED, SAVED, type SshSeed } from "./ssh-bridge.js";

const OUT = process.env.OXBIT_SSH_SCREENSHOTS ?? "evidence/ios-ssh";
const key = { id: "key-1", name: "Phone", algorithm: "ssh-ed25519", fingerprint: "SHA256:Zq0c7Qm4l7gK3qGxw0b3m8R3pYk9uTn2vL6hJd1sFfE", publicKey: "ssh-ed25519 AAAAC3Nza phone@oxbit-ios" };
const host = { id: "host-1", label: "Build box", hostname: "build.example.test", port: 22, username: "dev", auth: "key" as const, keyId: "key-1", passwordSaved: false };

async function start(page: Page, seed?: SshSeed) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await installBridge(page);
  await installSshBridge(page, seed);
  await page.goto("/");
  return errors;
}

/** Saves the current screen at 393x852 and 320x700. */
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

async function connect(page: Page, folder?: string) {
  await page.getByRole("button", { name: "Connect with SSH…", exact: true }).click();
  expect(await topmost(page, "Connect with SSH")).toBe(true);
  if (folder) await page.getByRole("textbox", { name: "Remote folder" }).fill(folder);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

test("SSH Hosts and Keys generates a key, copies its public key, and saves a host", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = await start(page);
  await page.getByRole("button", { name: "SSH Hosts and Keys…", exact: true }).click();
  expect(await topmost(page, "SSH Hosts and Keys")).toBe(true);
  await page.getByRole("textbox", { name: "SSH key name" }).fill("Phone");
  await page.getByRole("button", { name: "Generate Ed25519 Key", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(`Added Phone (${key.fingerprint}).`);
  await shoot(page, "key-generation");
  await page.getByRole("button", { name: "Copy public key", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Copied the public key for Phone.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^ssh-ed25519 \S+ Phone@oxbit-ios$/);

  await page.getByRole("button", { name: "Add Host…", exact: true }).click();
  await page.getByRole("textbox", { name: "Host name" }).fill("Build box");
  await page.getByRole("textbox", { name: "Hostname" }).fill("build.example.test");
  await page.getByRole("textbox", { name: "Username" }).fill("dev");
  await expect(page.getByRole("combobox", { name: "SSH key" })).toHaveValue("key-1");
  await page.getByRole("button", { name: "Save Host", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved Build box.");
  await expect(page.locator(".ssh-row", { hasText: "Build box" })).toContainText("dev@build.example.test · Phone");
  await shoot(page, "hosts-dialog");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Port" }).fill("2222");
  await page.getByRole("button", { name: "Save Host", exact: true }).click();
  await expect(page.locator(".ssh-row", { hasText: "Build box" })).toContainText("dev@build.example.test:2222");
  expect(errors).toEqual([]);
});

test("a first connection shows the host key fingerprint, then opens the SFTP workspace", async ({ page }) => {
  const errors = await start(page, { hosts: [host], keys: [key] });
  await connect(page, "project");
  const prompt = page.getByRole("dialog", { name: "Confirm Host Key", exact: true });
  await expect(prompt).toContainText(PRESENTED.fingerprint);
  await expect(prompt).toContainText("ssh-ed25519");
  await expect(prompt).toContainText("build.example.test:22");
  await shoot(page, "fingerprint-prompt");
  await prompt.getByRole("button", { name: "Trust and Connect", exact: true }).click();
  await expect(page.locator(".workspace-title")).toHaveText("Build box: project");

  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "src" })).toBeVisible();
  await shoot(page, "sftp-explorer");
  await page.getByRole("treeitem", { name: "README.md" }).click();
  await expect(page.locator(".cm-content")).toContainText("# Remote project");

  await page.locator(".workspace-title").click();
  const recent = page.getByRole("region", { name: "On a server" }).getByRole("button", { name: /^Build box: project/ });
  await expect(recent).toContainText("/home/dev/project");
  await recent.click();
  await expect(page.getByRole("dialog", { name: "Workspaces" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Connect with SSH" })).toHaveCount(0);
  const opened = await page.evaluate(() => (window as any).__sshMock.calls.filter((call: string) => call === "ios_ssh_open_root"));
  expect(opened).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a changed host key is refused with both fingerprints until the saved key is forgotten", async ({ page }) => {
  const errors = await start(page, { hosts: [host], keys: [key], known: { "host-1": [SAVED] } });
  await connect(page);
  const refused = page.getByRole("alertdialog", { name: "Host Key Changed", exact: true });
  await expect(refused.getByRole("alert")).toContainText("does not match the saved key. Oxbit did not connect.");
  await expect(refused).toContainText(`Saved${SAVED.algorithm}${SAVED.fingerprint}`);
  await expect(refused).toContainText(`Presented${PRESENTED.algorithm}${PRESENTED.fingerprint}`);
  await shoot(page, "mismatch-error");
  expect(await page.evaluate(() => (window as any).__sshMock.calls)).not.toContain("ios_ssh_open_root");

  await refused.getByRole("button", { name: "Forget saved host key", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Forgot the saved host key. Connect again to review the new fingerprint.");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Confirm Host Key", exact: true })).toContainText(PRESENTED.fingerprint);
  expect(await page.evaluate(() => (window as any).__sshMock.calls)).not.toContain("ios_ssh_open_root");
  expect(errors).toEqual([]);
});

test("uploads and downloads show progress, finish, and cancel from the explorer menu", async ({ page }) => {
  const errors = await start(page, { hosts: [host], keys: [key], known: { "host-1": [{ ...PRESENTED, added: 1 }] } });
  await connect(page);
  await expect(page.locator(".workspace-title")).toHaveText("Build box: dev");

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Show All Commands", exact: true }).click();
  await page.getByRole("combobox", { name: "Search files and commands" }).fill(">SSH Hosts");
  await page.getByRole("option", { name: /SSH Hosts and Keys/ }).click();
  expect(await topmost(page, "SSH Hosts and Keys")).toBe(true);
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await page.getByRole("treeitem", { name: "src" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Upload Files Here…" }).click();
  const upload = page.getByRole("dialog", { name: "Upload to Server", exact: true });
  await expect(upload.getByRole("progressbar")).toHaveAttribute("value", "40");
  await expect(upload).toContainText("40% · 1.7 MB of 4.2 MB");
  await expect(upload).toContainText("photo.png");
  await shoot(page, "transfer-progress");
  await page.evaluate(() => (window as any).__sshMock.release());
  await expect(upload.getByRole("status")).toHaveText("Uploaded 1 file (4.2 MB) to src.");
  expect(await page.evaluate(() => (window as any).__sshMock.files.has("src/photo.png"))).toBe(true);
  await upload.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByRole("treeitem", { name: "README.md" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Download to Device…" }).click();
  const download = page.getByRole("dialog", { name: "Download to Device", exact: true });
  await expect(download).toContainText("README.md");
  await download.getByRole("button", { name: "Cancel Transfer", exact: true }).click();
  await expect(download.getByRole("status")).toHaveText("Download cancelled. Nothing was saved.");
  expect(await page.evaluate(() => (window as any).__sshMock.calls)).toContain("plugin:oxbit-files|forget_folder");
  await download.getByRole("button", { name: "Done", exact: true }).click();
  await expect(download).toHaveCount(0);
  expect(errors).toEqual([]);
});
