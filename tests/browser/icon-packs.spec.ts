import { test, expect, type Page } from '@playwright/test';
const fixtures = 'tests/fixtures/icon-packs/';
async function ready(page: Page) { await page.goto('/'); await page.waitForFunction(() => (window as any).__oxbit?.ready); }
async function manager(page: Page) { await page.evaluate(() => (window as any).__oxbit.runCommand('iconPacks.manage')); await expect(page.getByRole('heading', { name: 'Icon Packs', exact: true })).toBeVisible(); }
async function install(page: Page, file: string) {
  await manager(page);
  await page.getByLabel('Import icon pack archive').setInputFiles(fixtures + file);
  const dialog = page.getByRole('dialog', { name: 'Review Icon Pack' }); await expect(dialog).toBeVisible();
  await expect(dialog.locator('.themed-icon').first()).toBeVisible();
  await dialog.getByRole('button', { name: /^(Install|Replace) Icon Pack$/ }).click(); await expect(dialog).toHaveCount(0);
}
async function selection(page: Page, kind: 'File' | 'Product', match: RegExp) {
  await page.getByRole('combobox', { name: `${kind} Icon Theme`, exact: true }).click();
  await page.getByRole('option', { name: match }).click();
}
async function state(page: Page) { return page.evaluate(() => { const { kernel } = (window as any).__oxbit; return { file: kernel.configuration.get('workbench.iconTheme'), product: kernel.configuration.get('workbench.productIconTheme'), packs: kernel.services.get('iconThemes').list().map((p: any) => p.id) }; }); }
test('imports real file and product packs independently, persists offline, survives lifecycle and multiple windows', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page); await install(page, 'vscode-minimal.zip');
  expect((await state(page)).file).toBe('oxbit.default');
  await selection(page, 'File', /^Minimal /);
  await expect(page.locator('[role="tree"] img.themed-icon').first()).toBeVisible();
  const fileId = (await state(page)).file;
  await install(page, 'material-product-icons.vsix');
  expect((await state(page)).product).toBe('oxbit.default');
  await selection(page, 'Product', /^Material /);
  await expect(page.getByRole('button', { name: 'Search', exact: true }).locator('span.themed-icon')).toBeVisible();
  const productId = (await state(page)).product; expect((await state(page)).file).toBe(fileId);
  await page.evaluate(async () => { const k = (window as any).__oxbit.kernel; await k.configuration.flush?.(); });
  await page.reload(); await page.waitForFunction(() => (window as any).__oxbit?.ready);
  expect(await state(page)).toMatchObject({ file: fileId, product: productId });
  await context.setOffline(true);
  await expect(page.locator('[role="tree"] img.themed-icon').first()).toBeVisible();
  expect(await page.locator('[role="tree"] img.themed-icon').first().evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  expect(await page.getByRole('button', { name: 'Search', exact: true }).locator('span.themed-icon').evaluate(el => document.fonts.check(`16px ${getComputedStyle(el).fontFamily}`))).toBe(true);
  await context.setOffline(false);
  const other = await context.newPage(); await ready(other); await manager(other);
  await manager(page);
  await page.getByRole('button', { name: 'Disable VS Code Minimal Icons', exact: true }).click();
  await expect(other.getByRole('button', { name: 'Enable VS Code Minimal Icons', exact: true })).toBeVisible();
  await expect(page.locator('[role="tree"] img.themed-icon')).toHaveCount(0);
  expect((await state(page)).file).toBe(fileId);
  await page.getByRole('button', { name: 'Enable VS Code Minimal Icons', exact: true }).click();
  await expect(page.locator('[role="tree"] img.themed-icon').first()).toBeVisible();
  await page.getByRole('button', { name: 'Uninstall VS Code Minimal Icons', exact: true }).click();
  await expect(other.getByRole('button', { name: 'Uninstall VS Code Minimal Icons', exact: true })).toHaveCount(0);
  await install(page, 'vscode-minimal.zip');
  await expect(page.locator('[role="tree"] img.themed-icon').first()).toBeVisible();
  expect((await state(page)).product).toBe(productId);
  await page.evaluate(async () => { await (window as any).__oxbit.runCommand('workspace.browser'); });
  await expect(page.locator('[role="tree"] img.themed-icon').first()).toBeVisible();
  expect(await state(page)).toMatchObject({ file: fileId, product: productId });
  expect(errors).toEqual([]); await other.close();
});
test('keyboard selection, isolated SVGs, color variants, font alignment and invalid replacement recovery', async ({ page }) => {
  const csp: string[] = [];
  await page.addInitScript(() => { (window as any).iconCsp = []; document.addEventListener('securitypolicyviolation', e => (window as any).iconCsp.push(e.violatedDirective)); });
  await ready(page); await install(page, 'vscode-minimal.zip'); await install(page, 'material-product-icons.vsix');
  const combo = page.getByRole('combobox', { name: 'File Icon Theme', exact: true });
  await combo.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(combo).toBeFocused(); await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await selection(page, 'Product', /^Material /);
  const ids = await state(page);
  for (const [mode, hc] of [['dark', false], ['light', false], ['dark', true], ['light', true]] as const) {
    await page.evaluate(([mode, hc]) => { const k = (window as any).__oxbit.kernel; const t = k.contributions.list('theme').find((t: any) => t.data?.resolved?.mode === mode && t.data?.resolved?.highContrast === hc); if (!t) throw new Error('Missing color fixture'); k.configuration.set('workbench.colorTheme', t.data.stableId ?? t.id); }, [mode, hc]);
    await expect(page.locator('[role="tree"] img.themed-icon').first()).toBeVisible();
    const button = page.getByRole('button', { name: 'Search', exact: true }); await expect(button).toHaveAccessibleName('Search');
    const bounds = await button.locator('.themed-icon').boundingBox(); expect(bounds?.width).toBe(18); expect(bounds?.height).toBe(18);
    await page.screenshot({ path: `evidence/icon-packs/${mode}${hc ? '-hc' : ''}.png` });
  }
  await page.getByLabel('Import icon pack archive').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid') });
  await expect(page.locator('.icon-packs [role="status"]')).not.toBeEmpty(); expect(await state(page)).toEqual(ids);
  csp.push(...await page.evaluate(() => (window as any).iconCsp)); expect(csp).toEqual([]);
});
