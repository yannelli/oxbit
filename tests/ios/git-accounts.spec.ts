import { expect, test, type Page } from "@playwright/test";
import { installBridge, type BridgeAccount } from "./bridge.js";

const octocat: BridgeAccount = { id: "github-octocat", provider: "github", host: "github.com", login: "octocat", isDefault: true };
const hubot: BridgeAccount = { id: "github-hubot", provider: "github", host: "github.com", login: "hubot", isDefault: false };
const gitea: BridgeAccount = {
  id: "gitea-user", provider: "gitea", host: "git.example.test:3000", url: "https://git.example.test:3000/gitea", login: "gitea.user", isDefault: true,
};
const TITLE = "Git Accounts and Commit Author";

async function openFromStart(page: Page, accounts: BridgeAccount[] = []) {
  await installBridge(page, { accounts });
  await page.goto("/");
  await page.getByRole("button", { name: `${TITLE}…`, exact: true }).click();
  return page.getByRole("dialog", { name: TITLE, exact: true });
}

async function openFromRepository(page: Page, accounts: BridgeAccount[]) {
  await installBridge(page, { repository: true, accounts });
  await page.goto("/");
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await expect(page.locator(".workspace-title")).toHaveText("Oxbit");
  await page.getByRole("button", { name: "Source Control", exact: true }).click();
  await page.locator(".scm-toolbar").getByRole("button", { name: TITLE, exact: true }).click();
  return page.getByRole("dialog", { name: TITLE, exact: true });
}

function row(dialog: ReturnType<Page["getByRole"]>, login: string) {
  return dialog.getByRole("listitem").filter({ has: dialog.page().getByText(login, { exact: true }) });
}

async function binding(page: Page) {
  return page.evaluate(() => (window as unknown as { __iosTest: { storage: Map<string, unknown> } }).__iosTest.storage.get("/device/Documents:git-account"));
}

test("adds two GitHub accounts and changes the default", async ({ page }) => {
  const dialog = await openFromStart(page);
  await expect(dialog.getByText("Public HTTPS repositories work without an account.")).toBeVisible();
  for (const login of ["octocat", "hubot"]) {
    await dialog.getByRole("button", { name: "Add GitHub Account" }).click();
    await dialog.getByLabel("GitHub access token").fill(login);
    await dialog.getByRole("button", { name: "Add Account" }).click();
    await expect(dialog.getByRole("status")).toHaveText(`Added ${login} on github.com.`);
  }
  await expect(row(dialog, "octocat").getByText("Default", { exact: true })).toBeVisible();
  await expect(row(dialog, "hubot").getByText("Default", { exact: true })).toHaveCount(0);
  await expect(row(dialog, "octocat").getByText("GitHub · github.com")).toBeVisible();

  await row(dialog, "hubot").getByRole("button", { name: "Make Default" }).click();
  await expect(row(dialog, "hubot").getByText("Default", { exact: true })).toBeVisible();
  await expect(row(dialog, "octocat").getByRole("button", { name: "Make Default" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "This Repository" })).toHaveCount(0);
});

test("reports a rejected token and keeps the editor open", async ({ page }) => {
  const dialog = await openFromStart(page);
  await dialog.getByRole("button", { name: "Add GitHub Account" }).click();
  await dialog.getByLabel("GitHub access token").fill("rejected");
  await dialog.getByLabel("GitHub access token").press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("GitHub rejected this token or its permissions.");
  await expect(dialog.getByRole("group", { name: "Add GitHub account" })).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveCount(0);
});

test("binds the open repository to a chosen account", async ({ page }) => {
  let dialog = await openFromRepository(page, [octocat, hubot, gitea]);
  const repository = dialog.getByRole("region", { name: "This Repository" });
  const picker = repository.getByRole("combobox", { name: "Account for this repository" });
  await expect(picker).toHaveText("Default (octocat)");
  await expect(repository.getByText("Fetch, pull, and push to github.com use octocat.")).toBeVisible();
  await picker.click();
  await expect(page.getByRole("option")).toHaveText(["Default (octocat)", "octocat", "hubot"]);
  await page.getByRole("option", { name: "hubot", exact: true }).click();
  await expect(repository.getByText("Fetch, pull, and push to github.com use hubot.")).toBeVisible();
  expect(await binding(page)).toBe("github-hubot");

  await dialog.getByRole("button", { name: "Done" }).click();
  await page.locator(".scm-toolbar").getByRole("button", { name: TITLE, exact: true }).click();
  dialog = page.getByRole("dialog", { name: TITLE, exact: true });
  await expect(dialog.getByRole("combobox", { name: "Account for this repository" })).toHaveText("hubot");
});

test("removes accounts, promotes the next default, and clears the binding", async ({ page }) => {
  const dialog = await openFromRepository(page, [octocat, hubot]);
  await dialog.getByRole("combobox", { name: "Account for this repository" }).click();
  await page.getByRole("option", { name: "octocat", exact: true }).click();
  expect(await binding(page)).toBe("github-octocat");

  await row(dialog, "octocat").getByRole("button", { name: "Remove octocat on github.com" }).click();
  await row(dialog, "octocat").getByRole("button", { name: "Keep" }).click();
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await row(dialog, "octocat").getByRole("button", { name: "Remove octocat on github.com" }).click();
  await row(dialog, "octocat").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Removed octocat from github.com.");
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await expect(row(dialog, "hubot").getByText("Default", { exact: true })).toBeVisible();
  expect(await binding(page)).toBeNull();
  await expect(dialog.getByRole("combobox", { name: "Account for this repository" })).toHaveText("Default (hubot)");
});

test("shows migrated GitHub and Gitea credentials as host defaults", async ({ page }) => {
  const dialog = await openFromStart(page, [octocat, gitea]);
  await expect(dialog.getByRole("textbox", { name: "Git author name" })).toHaveValue("Oxbit Test");
  await expect(row(dialog, "octocat").getByText("GitHub · github.com")).toBeVisible();
  await expect(row(dialog, "gitea.user").getByText("Gitea · git.example.test:3000")).toBeVisible();
  for (const login of ["octocat", "gitea.user"]) {
    await expect(row(dialog, login).getByText("Default", { exact: true })).toBeVisible();
    await expect(row(dialog, login).getByRole("button", { name: "Make Default" })).toHaveCount(0);
  }
});
