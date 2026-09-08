/* global browser, describe, it */
import assert from 'node:assert/strict';
import path from 'node:path';
describe('Native icon pack restart', () => {
  it('restores independently selected themes from the application store after process restart', async () => {
    await browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbitDesktop));
    await browser.execute(async p => { await globalThis.__oxbitDesktop.native.open(p); }, path.join(process.env.OXBIT_NATIVE_FIXTURES, 'Alpha project'));
    await browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbit?.ready));
    const result = await browser.execute(() => {
      const k = globalThis.__oxbit.kernel, s = k.services.get('iconThemes');
      return { file: k.configuration.get('workbench.iconTheme'), product: k.configuration.get('workbench.productIconTheme'), packs: s.list().length, fileKind: s.file({ path: 'hello.ts' }, 'dark')?.kind, productKind: s.product('search')?.kind };
    });
    assert.equal(result.packs, 2); assert.equal(result.file, 'vscode.theme-defaults/vs-minimal'); assert.equal(result.product, 'PKief.material-product-icons/material-product-icons');
    assert.equal(result.fileKind, 'image'); assert.equal(result.productKind, 'font');
    await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll('img.themed-icon')].some(img => img.complete && img.naturalWidth > 0)));
  });
});
