import { test, expect } from "@playwright/test";

test("technical text stays literal in fields, editors and floating panels", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const z = (window as any).__oxbit;
    await z.kernel.extensions.activate("oxbit.agent-acp");
    z.workbench.run("agentACP.open");
  });
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  const args = page.getByRole("textbox", { name: "Agent arguments" });
  for (const [name, value] of Object.entries({
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    autocomplete: "off",
    writingsuggestions: "false",
  })) await expect(args).toHaveAttribute(name, value);
  const literal = '["npx", "-y", "package-example"]';
  await args.fill("");
  await args.pressSequentially(literal);
  await expect(args).toHaveValue(literal);
  const composer = page.getByRole("textbox", { name: "Message agent" });
  await composer.pressSequentially('"quoted" -- flags ... teh');
  await expect(composer).toHaveValue('"quoted" -- flags ... teh');
  await expect(composer).toHaveAttribute("spellcheck", "false");
  await expect(composer).toHaveAttribute("writingsuggestions", "false");

  await page.evaluate(async () => {
    await (window as any).__oxbit.workbench.openFile("src/App.tsx");
  });
  await expect(page.locator(".cm-content[contenteditable=true]")).toHaveAttribute("autocorrect", "off");
  await expect(page.locator(".cm-content[contenteditable=true]")).toHaveAttribute("writingsuggestions", "false");

  const focused = await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "literal-input-fixture";
    field.setAttribute("autocorrect", "on");
    document.body.append(field);
    field.focus();
    return field.getAttribute("autocorrect");
  });
  expect(focused).toBe("off");
  await page.locator("#literal-input-fixture").evaluate((field) => field.setAttribute("spellcheck", "true"));
  await expect(page.locator("#literal-input-fixture")).toHaveAttribute("spellcheck", "false");
  await page.locator("#literal-input-fixture").evaluate((field) => field.remove());

  const popupPromise = page.waitForEvent("popup");
  await page.evaluate(() => (window as any).__oxbit.workbench.panelWindows.detach("agent-acp"));
  const popup = await popupPromise;
  const popupComposer = popup.getByRole("textbox", { name: "Message agent" });
  await expect(popupComposer).toHaveValue('"quoted" -- flags ... teh');
  await popup.getByRole("button", { name: "Setup", exact: true }).click();
  await popup.getByRole("button", { name: "Setup", exact: true }).click();
  const popupArgs = popup.getByRole("textbox", { name: "Agent arguments" });
  await expect(popupArgs).toHaveAttribute("autocorrect", "off");
  await expect(popupArgs).toHaveAttribute("writingsuggestions", "false");
  await popup.close();
});
