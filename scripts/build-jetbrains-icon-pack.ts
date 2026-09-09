// Reproducible importable icon pack; never evaluates or builds upstream extension code.
import { mkdir, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { associationMaps, importPack } from '../packages/icon-themes/src/import.js';
import { validateAsset } from '../packages/icon-themes/src/assets.js';
import type { Associations, Theme } from '../packages/icon-themes/src/types.js';

const require = createRequire(new URL('../packages/icon-themes/package.json', import.meta.url));
const { ZipWriter, BlobWriter, Uint8ArrayReader } = require('@zip.js/zip.js');

const repo = 'peakoss/vscode-jetbrains-icon-theme';
const revision = 'f7cc2cfb53390322fd8b9966494e80f73d71ff84';
const directory = new URL('../examples/icon-packs/', import.meta.url);
const records: { url: string; sha256: string }[] = [];

async function fetchFile(path: string): Promise<Uint8Array> {
  const url = `https://raw.githubusercontent.com/${repo}/${revision}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  records.push({ url, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  return bytes;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const upstream: Record<'dark' | 'light', Theme> = Object.create(null);
for (const variant of ['dark', 'light'] as const)
  upstream[variant] = JSON.parse(decoder.decode(await fetchFile(`assets/2023/theme-${variant}.json`))) as Theme;

function iconName(iconPath: string): string {
  const name = iconPath.split('/').pop()!;
  if (!/^[\w.-]+\.svg$/.test(name)) throw new Error(`Unexpected icon path: ${iconPath}`);
  return name;
}

const icons = new Map<string, Uint8Array>();
const themes: Record<'dark' | 'light', Theme> = Object.create(null);
for (const [variant, theme] of Object.entries(upstream) as [keyof typeof upstream, Theme][]) {
  const iconDefinitions: Theme['iconDefinitions'] = {};
  for (const [id, definition] of Object.entries(theme.iconDefinitions)) {
    if (Object.keys(definition).join() !== 'iconPath') throw new Error(`Unsupported definition: ${id}`);
    const name = iconName(definition.iconPath!);
    if (!icons.has(name)) {
      const bytes = await fetchFile(`assets/2023/icons/${name}`);
      if (validateAsset(name, bytes) !== 'image/svg+xml') throw new Error(`Not an SVG: ${name}`);
      icons.set(name, bytes);
    }
    // Definition paths resolve against the theme file's own directory, `themes/`.
    iconDefinitions[id] = { iconPath: `../icons/${name}` };
  }
  themes[variant] = { ...theme, iconDefinitions };
}

const singles = ['file', 'folder', 'folderExpanded', 'rootFolder', 'rootFolderExpanded'] as const;
function prefixIds(associations: Associations, prefix: string): Associations {
  const result: Associations = {};
  for (const key of singles) if (associations[key]) result[key] = prefix + associations[key];
  for (const key of associationMaps) {
    const entries = associations[key];
    if (!entries) continue;
    result[key] = Object.fromEntries(Object.entries(entries).map(([name, id]) => [name, prefix + id]));
  }
  return result;
}

/** The light side reuses the dark associations, which also restores the four `spec.*` extensions the upstream light theme omits. */
const auto: Theme = {
  ...themes.dark,
  iconDefinitions: {
    ...themes.dark.iconDefinitions,
    ...Object.fromEntries(
      Object.entries(themes.light.iconDefinitions).map(([id, definition]) => [`light.${id}`, definition]),
    ),
  },
  light: prefixIds(themes.dark, 'light.'),
};

const contributions = [
  ['2023', 'JetBrains 2023+', auto],
  ['2023-dark', 'JetBrains 2023+ Dark', themes.dark],
  ['2023-light', 'JetBrains 2023+ Light', themes.light],
] as const;

const manifest = {
  publisher: 'oxbit',
  name: 'jetbrains-icons',
  version: '2.40.0',
  displayName: 'JetBrains Icons',
  description:
    "IntelliJ-style icons for 150 file extensions, 87 file names and 14 folder names. JetBrains 2023+ follows the editor's light or dark mode; the Dark and Light themes pin one variant. Adapted from the MIT-licensed JetBrains Icon Theme by Chad Adams and contributors.",
  license: 'MIT',
  contributes: {
    iconThemes: contributions.map(([id, label]) => ({ id, label, path: `./themes/${id}.json` })),
  },
};

const license = await fetchFile('LICENSE.md');
const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
const lastModDate = new Date('2025-01-01T00:00:00Z');
const add = (path: string, bytes: Uint8Array) => writer.add(path, new Uint8ArrayReader(bytes), { lastModDate });
await add('package.json', json(manifest));
for (const [id, , data] of contributions)
  await add(`themes/${id}.json`, json({ $schema: '/schemas/icon-file.v1.schema.json', ...data }));
for (const [name, bytes] of [...icons].sort(([a], [b]) => (a < b ? -1 : 1))) await add(`icons/${name}`, bytes);
await add('LICENSE.md', license);
const archive = new Uint8Array(await (await writer.close()).arrayBuffer());

const pack = await importPack(new Blob([archive as BlobPart]), 'jetbrains-icons.zip');
if (pack.warnings.length) throw new Error(`Archive would import with warnings: ${pack.warnings.join('; ')}`);

await mkdir(directory, { recursive: true });
await writeFile(new URL('jetbrains-icons.zip', directory), archive);
await writeFile(
  new URL('upstream.json', directory),
  json({
    sources: records,
    notes: `JetBrains Icon Theme v2.40.0 by Chad Adams and contributors, commit ${revision}. The 2023+ UI theme data and its referenced SVGs only, repackaged under an Oxbit manifest with a third theme that merges the light and dark variants. MIT, with the Apache-2.0 Elixir and BEAM icons noted in LICENSE.md.`,
  }),
);
console.log(`Wrote ${icons.size} icons and ${pack.themes.length} themes from ${records.length} pinned sources.`);
