// Reproducible upstream fixtures; never evaluates or builds extension code.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/icon-themes/package.json', import.meta.url));
const { ZipWriter, BlobWriter, Uint8ArrayReader } = require('@zip.js/zip.js');
const directory = new URL('../tests/fixtures/icon-packs/', import.meta.url);
await fs.mkdir(directory, { recursive: true });
const records = [];
async function fetchFile(repo, revision, path) {
  const url = `https://raw.githubusercontent.com/${repo}/${revision}/${path}`;
  const response = await fetch(url); if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  records.push({ url, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  return bytes;
}
const vscode = '19e0f9e681ecb8e5c09d8784acaa601316ca4571';
const product = '46ba756bc8016862b4748c6a94719ce9642119da';
for (const [repo, revision, output, prefix, names] of [
  ['microsoft/vscode', vscode, 'vscode-minimal.zip', '', ['package.json', 'fileicons/vs_minimal-icon-theme.json', ...['document','folder','folder-open','root-folder','root-folder-open'].flatMap(n => ['dark','light'].map(mode => `fileicons/images/${n}-${mode}.svg`))]],
  ['material-extensions/vscode-material-product-icons', product, 'material-product-icons.vsix', 'extension/', ['package.json','theme/material-icons.woff','theme/material.product-icon-theme.json']],
]) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const name of names) {
    const path = repo === 'microsoft/vscode' ? 'extensions/theme-defaults/' + name : name;
    let bytes = await fetchFile(repo, revision, path);
    if (name === 'package.json' && repo === 'microsoft/vscode') {
      // Resolve upstream localized labels only; preserve contributes and theme data.
      const manifest = JSON.parse(new TextDecoder().decode(bytes));
      manifest.displayName = 'VS Code Minimal Icons';
      manifest.description = 'Pinned VS Code built-in Minimal file icons';
      for (const theme of manifest.contributes.iconThemes) theme.label = 'Minimal';
      bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    }
    await writer.add(prefix + name, new Uint8ArrayReader(bytes), { lastModDate: new Date('2025-01-01T00:00:00Z') });
  }
  const licenseName = repo === 'microsoft/vscode' ? 'LICENSE.txt' : 'LICENSE.md';
  const license = await fetchFile(repo, revision, licenseName);
  await writer.add(prefix + licenseName, new Uint8ArrayReader(license), { lastModDate: new Date('2025-01-01T00:00:00Z') });
  await fs.writeFile(new URL(output, directory), new Uint8Array(await (await writer.close()).arrayBuffer()));
}
await fs.writeFile(new URL('upstream.json', directory), JSON.stringify({ sources: records, notes: 'VS Code 1.100.0 and Material Product Icons v1.7.1. Declarative subsets with original manifests, theme files and assets; VS Code localization labels resolved for fixture display. MIT licenses inside each archive.' }, null, 2)+'\n');
