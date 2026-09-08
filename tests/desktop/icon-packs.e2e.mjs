/* global browser, $, describe, it */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
const ready = () => browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbit?.ready && globalThis.__oxbit.workbench === globalThis.__oxbitDesktop.manager.active?.session?.workbench), { timeout: 45000 });
async function importFile(name) {
  const data = (await readFile(path.resolve('tests/fixtures/icon-packs', name))).toString('base64');
  await browser.execute(() => globalThis.__oxbit.workbench.run('iconPacks.manage'));
  await $('[aria-label="Import icon pack archive"]').waitForExist();
  await browser.execute((name, data) => {
    const input = document.querySelector('[aria-label="Import icon pack archive"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], name, { type: 'application/zip' }));
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, name, data);
  await browser.waitUntil(() => browser.execute(() => !!document.querySelector('.dialog') || !!document.querySelector('.icon-packs [role="status"]')?.textContent));
  await browser.waitUntil(() => browser.execute(() => document.querySelector('.icon-packs [role="status"]')?.textContent !== 'Validating icon pack…'));
  await $('.dialog').waitForDisplayed();
  await $('button=Install Icon Pack').waitForDisplayed();
  await $('button=Install Icon Pack').click();
  await browser.waitUntil(() => browser.execute(() => !document.querySelector('.dialog')));
}
describe('Native icon packs', () => {
  it('imports both upstream packs, renders under native CSP, persists and recovers across project changes', async () => {
    await browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbitDesktop));
    await browser.execute(async p => { await globalThis.__oxbitDesktop.native.open(p); }, path.join(process.env.OXBIT_NATIVE_FIXTURES, 'Alpha project'));
    await ready();
    await browser.execute(() => { globalThis.iconViolations = []; document.addEventListener('securitypolicyviolation', e => globalThis.iconViolations.push(e.violatedDirective)); });
    await importFile('vscode-minimal.zip'); await importFile('material-product-icons.vsix');
    const ids = await browser.execute(async () => {
      const k = globalThis.__oxbit.kernel, s = k.services.get('iconThemes');
      const file = s.themes('fileIconTheme')[0].id, product = s.themes('productIconTheme')[0].id;
      if (k.configuration.get('workbench.iconTheme') !== 'oxbit.default') throw new Error('Install changed selection');
      k.configuration.set('workbench.iconTheme', file); k.configuration.set('workbench.productIconTheme', product);
      await k.configuration.flush(); return { file, product };
    });
    await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll('img.themed-icon')].some(img => img.complete && img.naturalWidth > 0)));
    const rendering = await browser.execute(() => {
      const font = document.querySelector('[aria-label="Search"] span.themed-icon');
      return { image: [...document.querySelectorAll('img.themed-icon')].some(img => img.complete && img.naturalWidth > 0), font: !!font && document.fonts.check(`18px ${getComputedStyle(font).fontFamily}`), violations: globalThis.iconViolations };
    });
    assert.equal(rendering.image, true); assert.equal(rendering.font, true); assert.deepEqual(rendering.violations, []);
    await browser.saveScreenshot(path.resolve('evidence/icon-packs/native-icons.png'));
    await browser.execute(async p => { await globalThis.__oxbitDesktop.native.open(p); }, path.join(process.env.OXBIT_NATIVE_FIXTURES, 'Beta 项目'));
    await ready();
    assert.deepEqual(await browser.execute(() => { const k = globalThis.__oxbit.kernel; return { file: k.configuration.get('workbench.iconTheme'), product: k.configuration.get('workbench.productIconTheme') }; }), ids);
    assert.equal(await browser.execute(() => globalThis.__oxbit.kernel.services.get('iconThemes').list().length), 2);
    await browser.refresh(); await ready();
    assert.deepEqual(await browser.execute(() => { const k = globalThis.__oxbit.kernel; return { file: k.configuration.get('workbench.iconTheme'), product: k.configuration.get('workbench.productIconTheme') }; }), ids);
    const recovery = await browser.execute(async () => {
      const k = globalThis.__oxbit.kernel, s = k.services.get('iconThemes'), id = s.list().find(p => p.themes.some(t => t.kind === 'fileIconTheme')).id;
      await s.enable(id, false); const fallback = !s.file({ path: 'hello.ts' }, 'dark'); await s.enable(id, true);
      return { fallback, restored: !!s.file({ path: 'hello.ts' }, 'dark') };
    });
    assert.deepEqual(recovery, { fallback: true, restored: true });
  });
});
