import { expect, test } from "@playwright/test";

test("MDX completion, automatic schemas and persisted project insights work in the editor", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    await app.runtime.trust(true);
    for (const [path, text] of [
      ["helper.ts", 'export function welcome(name: string) { return "Hello " + name; }'],
      ["guide.mdx", 'import { welcome } from "./helper.js"\n\nexport const message = "hello"\n\n# Guide\n\n{message.toUp}\n\n{welcome("world")}\n'],
      ["tsconfig.browser.json", '{\n  ""\n}'],
    ]) await app.runtime.request("fs.write", { path, text, expectedRevision: null });
    await app.openFile("guide.mdx");
    await app.kernel.services.get("language").serviceForPath("guide.mdx").start(true);
    const view = app.workbench.activeEditor();
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("message.toUp") + "message.toUp".length } }); view.focus();
  });
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("toUpperCase");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.documents.get("guide.mdx").text.toString())).toContain("message.toUpperCase");
  await page.evaluate(async () => {
    const app = (window as any).__oxbit; await app.openFile("tsconfig.browser.json");
    await app.kernel.services.get("language").serviceForPath("tsconfig.browser.json").start(true);
    const view = app.workbench.activeEditor(); view.dispatch({ selection: { anchor: 5 } }); view.focus();
  });
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("compilerOptions");
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const app = (window as any).__oxbit; await app.openFile("guide.mdx");
    await app.runtime.request("project.refresh");
    await app.kernel.commands.execute("project.intelligence");
  });
  await expect(page.getByRole("region", { name: "Related files" })).toContainText("helper.ts");
  await expect(page.getByRole("button", { name: "Refresh analysis" })).toBeEnabled();
  await expect(page.getByText(/Project settings:/)).toContainText("project.json");
  await page.screenshot({ path: "evidence/project-intelligence/project-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).__oxbit.kernel.commands.execute("view.toggleSidebar"));
  await expect(page.getByRole("button", { name: "Refresh analysis" })).toBeVisible();
  await page.screenshot({ path: "evidence/project-intelligence/project-phone.png" });
  expect(errors).toEqual([]);
});

test("Laravel joins PHP support only within an artisan project", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#pair=oxbit-acceptance-2026"); await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit; await app.runtime.trust(true);
    await app.runtime.request("fs.mkdir", { path: "laravel" }).catch(() => {});
    for (const [path, text] of [["plain.php", "<?php\n"], ["laravel/artisan", "<?php\n"], ["laravel/app.php", "<?php\n"], ["laravel/welcome.blade.php", "@i"]]) {
      const previous = await app.runtime.request("fs.read", { path }).catch(() => null);
      await app.runtime.request("fs.write", { path, text, expectedRevision: previous?.revision ?? null });
    }
    await app.openFile("plain.php");
  });
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.services.get("language").servicesForPath("plain.php").map((service: any) => service.transport.definitionId))).toEqual(["intelephense"]);
  await page.evaluate(() => { const app = (window as any).__oxbit; (window as any).__appOpen = app.openFile("laravel/app.php"); });
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.workbench.activePath())).toBe("laravel/app.php");
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.services.get("language").servicesForPath("laravel/app.php").map((service: any) => service.transport.definitionId))).toEqual(["intelephense", "laravel"]);
  await page.evaluate(() => { const app = (window as any).__oxbit; (window as any).__bladeOpen = app.openFile("laravel/welcome.blade.php"); });
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.workbench.activePath())).toBe("laravel/welcome.blade.php");
  await expect.poll(() => page.evaluate(() => (window as any).__oxbit.kernel.services.get("language").servicesForPath("laravel/welcome.blade.php").map((service: any) => service.transport.definitionId))).toEqual(["laravel"]);
  expect(errors).toEqual([]);
});

test("Language Servers names the PHP servers and starts Laravel until each runs or fails with a reason", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#pair=oxbit-acceptance-2026"); await page.waitForFunction(() => (window as any).__oxbit?.ready);
  await page.evaluate(async () => {
    const app = (window as any).__oxbit; await app.runtime.trust(true);
    await app.runtime.request("fs.mkdir", { path: "laravel-status" }).catch(() => {});
    for (const [path, text] of [["laravel-status/artisan", "<?php\n"], ["laravel-status/composer.json", '{"require":{"laravel/framework":"^12.0"}}'], ["laravel-status/PatientChartProposalsController.php", "<?php\nclass PatientChartProposalsController {}\n"]]) {
      const previous = await app.runtime.request("fs.read", { path }).catch(() => null);
      await app.runtime.request("fs.write", { path, text, expectedRevision: previous?.revision ?? null });
    }
    await app.openFile("laravel-status/PatientChartProposalsController.php");
  });
  await page.getByRole("button", { name: /^Language Servers:/ }).click();
  const servers = page.getByRole("dialog", { name: "Language Servers", exact: true }).locator(".lsp-server");
  await expect(servers).toHaveCount(2);
  await expect(servers.locator(".lsp-server-name strong")).toHaveText([/^Intelephense$/i, /^Laravel/]);
  for (const server of await servers.all()) {
    await expect(server.locator(".lsp-server-state")).toHaveText(/^(Running|Failed)$/, { timeout: 180_000 });
    if (await server.locator(".lsp-server-state").textContent() === "Failed") await expect(server.locator(".lsp-server-error")).toHaveText(/\S/);
  }
  expect(errors).toEqual([]);
});
