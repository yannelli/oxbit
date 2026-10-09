import { expect, test } from "@playwright/test";
import { installBridge } from "./bridge.js";

const servers = ["typescript", "json", "yaml", "dockerfile", "shell", "zsh", "python"].map(id => `oxbit.language-${id}`);
async function openExtensions(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "More", exact: true }).tap();
  await page.getByRole("dialog", { name: "Panels" }).getByRole("button", { name: "Extensions" }).tap();
}
const disabled = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as any).__iosTest.storage.get("/device/Documents:extension-disabled") as string[]);

test("language servers are separate extensions with their own file type settings", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.evaluate(() => (window as any).__iosTest.storage.set("/device/Documents:extension-disabled", ["oxbit.ios-language"]));
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.locator(".cm-content")).toContainText("/device/Documents");
  expect(await disabled(page)).toEqual(servers);

  await openExtensions(page);
  await page.getByRole("textbox", { name: "Search extensions" }).fill("Language Server");
  await expect(page.locator(".extension-card strong")).toContainText(["TypeScript / JavaScript Language Server", "JSON Language Server", "YAML Language Server", "Dockerfile Language Server", "Bash / sh Language Server", "Zsh Language Server", "Python Language Server"]);
  await page.screenshot({ path: "/tmp/oxbit-p2/browser-extensions-list.png" });
  await page.locator(".extension-card", { hasText: "YAML Language Server" }).tap();
  await expect(page.locator(".extension-details h1")).toHaveText("YAML Language Server");

  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(page.getByRole("heading", { name: "YAML Language Server Settings" })).toBeVisible();
  await expect(page.locator(".setting-row")).toHaveCount(3);
  await expect(page.locator(".setting-id")).toContainText(["languageServer.yaml.fileTypes", "yaml.schemaStore.enable", "yaml.schemaDownload.enable"]);
  const fileTypes = page.getByRole("group", { name: "YAML: File Types" });
  await expect(fileTypes.getByRole("textbox")).toHaveCount(1);
  await expect(fileTypes.getByRole("textbox", { name: "YAML: File Types, item 1" })).toHaveValue("yaml");
  await fileTypes.getByRole("button", { name: "Add Item" }).click();
  await fileTypes.getByRole("textbox", { name: "YAML: File Types, item 2" }).fill("**/*.yaml.tmpl");
  await expect(page.locator(".setting-row.modified")).toHaveCount(1);
  await page.screenshot({ path: "/tmp/oxbit-p2/browser-extension-configure.png" });
  await fileTypes.getByRole("button", { name: "Remove yaml" }).click();
  await expect(fileTypes.getByRole("textbox")).toHaveCount(1);
  await expect(fileTypes.getByRole("textbox", { name: "YAML: File Types, item 1" })).toHaveValue("**/*.yaml.tmpl");

  await openExtensions(page);
  await page.locator(".extension-card", { hasText: "YAML Language Server" }).tap();
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
  await expect.poll(() => disabled(page)).not.toContain("oxbit.language-yaml");
  expect(await disabled(page)).toEqual(expect.arrayContaining(servers.filter(id => id !== "oxbit.language-yaml")));
});
