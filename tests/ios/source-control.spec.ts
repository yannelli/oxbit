import { expect, test, type Page } from "@playwright/test";
import { installBridge } from "./bridge.js";

const dialogs = [
  { button: "Connect Runtime…", dialog: "Runtime Connection" },
  { button: "Clone Repository…", dialog: "Clone Repository" },
  { button: "Git Accounts and Commit Author…", dialog: "Git Accounts and Commit Author" },
];

async function openDocuments(page: Page) {
  await installBridge(page, { repository: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.locator(".workspace-title")).toHaveText("Oxbit");
}

async function topmost(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
}

for (const { button, dialog } of dialogs) {
  test(`${dialog} opens above the workspace sheet`, async ({ page }) => {
    await openDocuments(page);
    await page.locator(".workspace-title").click();
    await expect(page.getByRole("dialog", { name: "Workspaces" })).toBeVisible();
    await page.getByRole("button", { name: button, exact: true }).click();
    expect(await topmost(page, dialog)).toBe(true);
  });
}

test("Git Accounts and Commit Author is in the palette and the Source Control toolbar", async ({ page }) => {
  await openDocuments(page);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Show All Commands", exact: true }).click();
  await page.getByRole("combobox", { name: "Search files and commands" }).fill(">Git Accounts");
  await page.getByRole("option", { name: /Git Accounts and Commit Author/ }).click();
  expect(await topmost(page, "Git Accounts and Commit Author")).toBe(true);
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByRole("button", { name: "Source Control", exact: true }).click();
  await page.locator(".scm-toolbar").getByRole("button", { name: "Git Accounts and Commit Author", exact: true }).click();
  expect(await topmost(page, "Git Accounts and Commit Author")).toBe(true);
  await expect(page.getByRole("textbox", { name: "Git author name" })).toHaveValue("Oxbit Test");
});
