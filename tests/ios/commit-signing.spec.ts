import { expect, test, type Page } from "@playwright/test";
import { installBridge } from "./bridge.js";

async function openGitSettings(page: Page) {
  await installBridge(page, { repository: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Oxbit Files app" }).click();
  await page.getByRole("button", { name: "Source Control", exact: true }).click();
  await page.locator(".scm-toolbar").getByRole("button", { name: "Git Accounts and Commit Author", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Git Accounts and Commit Author", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Git author email" })).toHaveValue("oxbit@example.test");
  return dialog.getByRole("region", { name: "Commit Signing" });
}

const signing = (page: Page) => page.evaluate(() => (window as any).__iosTest.signing as { enabled: boolean; key?: unknown });

test("creates a signing key, copies its public key, toggles signing, and removes it", async ({ page }) => {
  const section = await openGitSettings(page);
  await section.getByRole("button", { name: "Create Signing Key" }).click();
  await expect(section.getByRole("status")).toHaveText("Signing key created.");
  await expect(section.getByText("Oxbit Test <oxbit@example.test>")).toBeVisible();
  await expect(section.getByText("0123 4567 89AB CDEF 0123 4567 89AB CDEF 0123 4567")).toBeVisible();
  await expect(section.locator(".warning-text")).toHaveCount(0);

  await section.getByRole("button", { name: "Copy Public Key" }).click();
  await expect(section.getByRole("status")).toHaveText("Public key copied.");
  expect(await page.evaluate(() => (window as any).__iosTest.copied)).toEqual([
    "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nfixture\n-----END PGP PUBLIC KEY BLOCK-----\n",
  ]);

  const toggle = section.getByRole("switch", { name: "Sign commits" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect((await signing(page)).enabled).toBe(true);

  await page.getByRole("textbox", { name: "Git author email" }).fill("other@example.test");
  await expect(section.locator(".warning-text")).toContainText("do not include other@example.test");

  await section.getByRole("button", { name: "Remove Signing Key…" }).click();
  await section.getByRole("button", { name: "Remove Key", exact: true }).click();
  await expect(section.getByRole("status")).toHaveText("Signing key removed.");
  await expect(section.getByRole("button", { name: "Create Signing Key" })).toBeVisible();
  await expect(section.getByRole("switch")).toHaveCount(0);
  expect(await signing(page)).toEqual({ enabled: false });
});

test("touch targets in the signing section are at least 44px tall", async ({ page }) => {
  const section = await openGitSettings(page);
  await section.getByRole("button", { name: "Create Signing Key" }).click();
  await expect(section.getByRole("switch", { name: "Sign commits" })).toBeVisible();
  for (const control of await section.locator("button, label:has([role=switch])").all())
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
