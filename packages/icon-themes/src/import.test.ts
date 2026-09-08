import { describe, expect, it } from 'vitest';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { importPack, LIMITS, safePath } from './import.js';
import { decodeCharacter, validateAsset } from './assets.js';
import { readFile } from 'node:fs/promises';
export const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#0af" d="M0 0h16v16H0z"/></svg>';
export const manifest = { publisher: 'test', name: 'icons', version: '1.0.0', license: 'MIT', contributes: { iconThemes: [{ id: 'files', label: 'Test Files', path: 'themes/files.json' }, { id: 'other', path: 'themes/files.json' }], commands: [{ command: 'unsafe' }] }, scripts: { postinstall: 'do not run' }, main: 'code.js' };
export const theme = { iconDefinitions: { file: { iconPath: '../images/file.svg' }, folder: { iconPath: '../images/folder.svg' } }, file: 'file', folder: 'folder' };
export async function archive(entries: Record<string, string | Uint8Array> = {}, options: { prefix?: string; password?: string; symlink?: string } = {}) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [name, content] of Object.entries({ 'package.json': JSON.stringify(manifest), 'themes/files.json': JSON.stringify(theme), 'images/file.svg': svg, 'images/folder.svg': svg.replace('#0af', '#fa0'), 'code.js': 'globalThis.ICON_PACK_EXECUTED = true', 'LICENSE': 'MIT test fixture', ...entries })) {
    await writer.add((options.prefix ?? '') + name, typeof content === 'string' ? new TextReader(content) : new Uint8ArrayReader(content), { password: options.password, ...(options.symlink === name ? { unixMode: 0o120777 } : {}) });
  }
  return writer.close();
}
describe('bounded declarative archive import', () => {
  it('imports multiple JSONC themes and only referenced assets and licenses', async () => {
    const pack = await importPack(await archive({ 'themes/files.json': '// a comment\n' + JSON.stringify(theme), 'unused.svg': svg }), 'test.zip');
    expect(pack.themes.map(t => t.id)).toEqual(['test.icons/files', 'test.icons/other']);
    expect(Object.keys(pack.assets)).toEqual(['images/file.svg', 'images/folder.svg', 'LICENSE']);
    expect(pack.warnings.join()).toContain('commands');
    expect((globalThis as any).ICON_PACK_EXECUTED).toBeUndefined();
  });
  it('accepts VSIX extension root and rejects wrong layouts', async () => {
    const bytes = await archive({}, { prefix: 'extension/' });
    expect((await importPack(bytes, 'icons.vsix')).id).toBe('test.icons');
    await expect(importPack(bytes, 'icons.zip')).rejects.toThrow('package.json');
  });
  it.each(['../escape', '/absolute', 'C:/absolute', 'https://example.com/a', 'a\\b', 'a%2fb', 'a\u0000b'])('rejects unsafe path %s', path => expect(() => safePath(path)).toThrow());
  it('permits bounded parent asset references', () => expect(safePath('../icons/a.svg', 'themes')).toBe('icons/a.svg'));
  it('rejects duplicate normalized and case-insensitive paths', async () => {
    await expect(importPack(await archive({ 'images/./file.svg': svg }), 'test.zip')).rejects.toThrow('Duplicate');
    await expect(importPack(await archive({ 'Images/file.svg': svg }), 'test.zip')).rejects.toThrow('Duplicate');
  });
  it('rejects symlinks and encrypted archives', async () => {
    await expect(importPack(await archive({}, { symlink: 'images/file.svg' }), 'test.zip')).rejects.toThrow('special');
    await expect(importPack(await archive({}, { password: 'secret' }), 'test.zip')).rejects.toThrow('Encrypted');
  });
  it('rejects missing definitions, missing assets, external and escaping references', async () => {
    for (const change of [{ ...theme, file: 'absent' }, { ...theme, iconDefinitions: { file: { iconPath: 'absent.svg' }, folder: { iconPath: '../images/folder.svg' } } }, { ...theme, iconDefinitions: { file: { iconPath: '../../outside.svg' }, folder: { iconPath: '../images/folder.svg' } } }]) await expect(importPack(await archive({ 'themes/files.json': JSON.stringify(change) }), 'test.zip')).rejects.toThrow();
  });
  it('reports schema and JSON syntax errors', async () => {
    await expect(importPack(await archive({ 'themes/files.json': '{ invalid }' }), 'test.zip')).rejects.toThrow('JSONC');
    await expect(importPack(await archive({ 'themes/files.json': '{"iconDefinitions":[]}' }), 'test.zip')).rejects.toThrow('object');
    await expect(importPack(await archive({ 'package.json': '{}' }), 'test.zip')).rejects.toThrow('publisher');
  });
  it('enforces compressed, decompressed, JSON, asset and entry limits', async () => {
    const blob = await archive();
    for (const limits of [{ compressed: 1 }, { decompressed: 16 }, { json: 16 }, { asset: 16 }, { entries: 1 }]) await expect(importPack(blob, 'test.zip', undefined, { ...LIMITS, ...limits })).rejects.toThrow(/limit/);
  });
  it('rejects forged small decompressed sizes using actual streamed bytes', async () => {
    const bytes = new Uint8Array(await (await archive({ 'large.bin': new Uint8Array(30_000) })).arrayBuffer());
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1, true);
    await expect(importPack(new Blob([bytes]), 'test.zip', undefined, { ...LIMITS, decompressed: 1000 })).rejects.toThrow();
  });
  it('supports cancellation before and during decompression', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(importPack(await archive(), 'test.zip', controller.signal)).rejects.toThrow();
    const signal = new AbortController(), blob = await archive({ 'large.bin': new Uint8Array(2_000_000) });
    const pending = importPack(blob, 'test.zip', signal.signal); setTimeout(() => signal.abort(), 0);
    await expect(pending).rejects.toThrow();
  });
  it('rejects malformed archives', async () => await expect(importPack(new Blob(['not zip']), 'bad.zip')).rejects.toThrow());
  it.each(['<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>', '<svg xml:base="//example.com"><use href="#x"/></svg>', '<svg><use href="https://example.com/a"/></svg>', '<svg><foreignObject/></svg>', '<!DOCTYPE svg [<!ENTITY x "test">]><svg/>', '<svg><path fill="url(https://example.com/a)"/></svg>', '<svg><path style="fill:u\\72l(https://example.com)"/></svg>', '<svg><image href="data:image/png;base64,x"/></svg>'])('rejects active SVG %s', async value => await expect(importPack(await archive({ 'images/file.svg': value }), 'test.zip')).rejects.toThrow());
  it('accepts safe local SVG gradients', () => expect(validateAsset('a.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="#fff"/></linearGradient></defs><path fill="url(#g)"/></svg>'))).toBe('image/svg+xml'));
  it('decodes literal and escaped glyphs and rejects invalid Unicode', () => {
    expect(decodeCharacter('\\E001')).toBe('\ue001'); expect(decodeCharacter('A')).toBe('A');
    for (const value of ['\\110000', '\\d800', 'two', '\\0']) expect(() => decodeCharacter(value)).toThrow();
  });
  it('rejects forged fonts and PNGs', () => {
    for (const path of ['a.woff', 'a.woff2', 'a.ttf', 'a.otf', 'a.png']) expect(() => validateAsset(path, new Uint8Array(50))).toThrow();
  });
  it('imports pinned real upstream packages offline', async () => {
    for (const name of ['vscode-minimal.zip', 'material-product-icons.vsix']) {
      const bytes = await readFile(`tests/fixtures/icon-packs/${name}`);
      const pack = await importPack(new Blob([bytes]), name);
      expect(pack.themes.length).toBeGreaterThan(0);
      expect(Object.values(pack.assets).some(a => a.mime === (name.endsWith('.zip') ? 'image/svg+xml' : 'font/woff'))).toBe(true);
    }
  });
});
