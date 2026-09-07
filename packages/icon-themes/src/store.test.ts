import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createKernel } from '../../core/src/index.js';
import { BrowserPackStore, IconThemeService, importPack } from './index.js';
import type { Pack, PackStore } from './types.js';
import { PackResources } from './resources.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.restoreAllMocks(); });
async function sample() { return importPack(new Blob([await readFile('tests/fixtures/icon-packs/vscode-minimal.zip')]), 'minimal.zip'); }
function store(name = crypto.randomUUID()) { const s = new BrowserPackStore(name); cleanup.push(() => s.dispose()); return s; }
async function service(storage: PackStore) {
  const kernel = createKernel(), notice = vi.fn();
  for (const id of ['workbench.iconTheme','workbench.productIconTheme']) kernel.configuration.register({ id, title: id, type: 'string', default: 'oxbit.default' });
  const s = new IconThemeService(kernel, storage, notice); await s.initialize();
  cleanup.push(() => { s.dispose(); kernel.dispose(); });
  return { service: s, kernel, notice };
}
describe('atomic pack persistence', () => {
  it('persists across independent project stores and reloads', async () => {
    const name = crypto.randomUUID(), a = store(name), b = store(name), pack = await sample();
    await a.put(pack); expect((await b.read())[0].id).toBe(pack.id);
    await b.enable(pack.id, false); expect((await a.read())[0].enabled).toBe(false);
    expect((await store(name).read())[0].revision).toBe(pack.revision);
  });
  it('serializes concurrent installs without losing unrelated packs', async () => {
    const s = store(), first = await sample(), second = { ...first, id: 'other.icons', revision: crypto.randomUUID() };
    await Promise.all([s.put(first), s.put(second)]); expect(await s.read()).toHaveLength(2);
  });
  it('retains the prior revision when immutable writes fail', async () => {
    const s = store(), pack = await sample(); await s.put(pack);
    await expect(s.put({ ...pack, label: 'must not replace' })).rejects.toThrow();
    expect((await s.read())[0].label).toBe(pack.label);
    const replacement = { ...pack, revision: crypto.randomUUID(), version: '2.0' };
    await s.put(replacement); expect((await s.read())[0].version).toBe('2.0');
    await s.remove(pack.id); expect(await s.read()).toEqual([]);
  });
  it('notifies another window only after committed changes', async () => {
    const name = crypto.randomUUID(), a = store(name), b = store(name), listener = vi.fn(); b.subscribe(listener);
    await a.put(await sample()); await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    listener.mockClear(); const pack = (await a.read())[0]; await expect(a.put(pack)).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
  it('keeps a previous installation when the index write fails', async () => {
    const s = store(), pack = await sample(); await s.put(pack);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'installed') throw new Error('simulated storage failure'); return original.apply(this, args);
    });
    await expect(s.put({ ...pack, revision: crypto.randomUUID(), version: 'broken' })).rejects.toThrow('storage failure');
    expect((await s.read())[0].version).toBe(pack.version);
  });
});
describe('shared service lifecycle', () => {
  it('installs without selection, falls back on disable/removal, restores retained IDs on reinstall', async () => {
    const { service: s, kernel, notice } = await service(store());
    const bytes = new Blob([await readFile('tests/fixtures/icon-packs/vscode-minimal.zip')]);
    const preview = await s.preview(bytes, 'icons.zip');
    expect(preview.samples.some(a => a.kind === 'image')).toBe(true);
    await s.install(preview); expect(kernel.configuration.get('workbench.iconTheme')).toBe('oxbit.default');
    const id = s.themes('fileIconTheme')[0].id, packId = s.list()[0].id;
    kernel.configuration.set('workbench.iconTheme', id);
    expect(s.file({ path: 'x' }, 'dark')?.kind).toBe('image');
    expect(s.product('search')).toBeUndefined();
    await s.enable(packId, false); expect(s.file({ path: 'x' }, 'dark')).toBeUndefined();
    expect(kernel.configuration.get('workbench.iconTheme')).toBe(id);
    expect(notice).toHaveBeenCalledTimes(1);
    await s.enable(packId, true); expect(s.file({ path: 'x' }, 'dark')?.kind).toBe('image');
    await s.remove(packId); expect(s.file({ path: 'x' }, 'dark')).toBeUndefined();
    await s.install(await s.preview(bytes, 'icons.zip')); expect(s.file({ path: 'x' }, 'dark')?.kind).toBe('image');
  });
  it('rejects mutated/foreign preview handles', async () => {
    const { service: s } = await service(store());
    await expect(s.install({ id: 'fake' } as any)).rejects.toThrow('expired');
    const preview = await s.preview(new Blob([await readFile('tests/fixtures/icon-packs/vscode-minimal.zip')]), 'icons.zip');
    preview.id = 'attacker.changed'; await s.install(preview);
    expect(s.list()[0].id).not.toBe('attacker.changed');
  });
  it('disposes preview and active object URLs', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { service: s, kernel } = await service(store());
    const blob = new Blob([await readFile('tests/fixtures/icon-packs/vscode-minimal.zip')]);
    const preview = await s.preview(blob, 'icons.zip'); preview.dispose(); expect(revoke).toHaveBeenCalled();
    await s.install(await s.preview(blob, 'icons.zip')); kernel.configuration.set('workbench.iconTheme', s.themes('fileIconTheme')[0].id);
    s.file({ path: 'test' }, 'dark'); revoke.mockClear(); s.dispose(); expect(revoke).toHaveBeenCalled();
  });
  it('falls back for corrupt stored assets and retains selection', async () => {
    const storage = store(), pack = await sample();
    const asset = Object.values(pack.assets).find(a => a.mime === 'image/svg+xml')!; asset.base64 = btoa('<svg><script/></svg>');
    await storage.put(pack); const { service: s, kernel, notice } = await service(storage);
    kernel.configuration.set('workbench.iconTheme', pack.themes[0].id);
    expect(s.file({ path: 'x' }, 'dark')).toBeUndefined(); expect(notice).toHaveBeenCalled();
  });
  it('refuses arrow hiding unless the rendered folder states differ', async () => {
    const storage = store(), pack = await sample(); pack.themes[0].data.hidesExplorerArrows = true;
    await storage.put(pack); const { service: s, kernel } = await service(storage);
    kernel.configuration.set('workbench.iconTheme', pack.themes[0].id);
    expect(s.hideArrows({ path: 'dir' }, 'dark')).toBe(true);
    const next: Pack = structuredClone(pack); next.revision = crypto.randomUUID(); next.themes[0].data.folderExpanded = next.themes[0].data.folder;
    await storage.put(next); await s.refresh(); expect(s.hideArrows({ path: 'dir' }, 'dark')).toBe(false);
  });
  it('requires browser font decoding before accepting a font pack', async () => {
    const pack = await importPack(new Blob([await readFile('tests/fixtures/icon-packs/material-product-icons.vsix')]), 'product.vsix');
    vi.stubGlobal('FontFace', class { load() { return Promise.reject(new Error('invalid font')); } });
    try { await expect(new PackResources(pack).load()).rejects.toThrow('Font decoding failed'); } finally { vi.unstubAllGlobals(); }
  });
});
it('loads scoped fonts from bytes, renders monochrome product glyphs, and removes fonts on disposal', async () => {
  const pack = await importPack(new Blob([await readFile('tests/fixtures/icon-packs/material-product-icons.vsix')]), 'product.vsix');
  pack.themes.push({ ...structuredClone(pack.themes[0]), id: pack.id + '/second' });
  const add = vi.fn(), remove = vi.fn();
  vi.stubGlobal('document', { fonts: { add, delete: remove } });
  vi.stubGlobal('FontFace', class {
    constructor(readonly family: string, readonly source: Uint8Array) { expect(source).toBeInstanceOf(Uint8Array); }
    load() { return Promise.resolve(this); }
  });
  try {
    const resources = new PackResources(pack); await resources.load();
    expect(add).toHaveBeenCalledTimes(pack.themes[0].data.fonts!.length);
    const asset = resources.asset(pack.themes[0], 'search');
    expect(asset?.kind).toBe('font'); expect(asset && 'color' in asset ? asset.color : undefined).toBeUndefined();
    resources.dispose(); expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
  } finally { vi.unstubAllGlobals(); }
});
