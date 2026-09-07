import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { importPack } from '../packages/icon-themes/src/import.js';
import { base64ToBytes, decodeCharacter } from '../packages/icon-themes/src/assets.js';
const require = createRequire(new URL('../packages/icon-themes/package.json', import.meta.url));
const { create } = require('fontkit');
const paths = process.argv.slice(2);
if (!paths.length) { console.error('Usage: pnpm icons:validate path/to/icons.zip [other.vsix]'); process.exitCode = 1; }
for (const path of paths) {
  try {
    const pack = await importPack(new Blob([await readFile(path)]), path);
    for (const theme of pack.themes) for (const font of theme.data.fonts ?? []) for (const src of font.src) {
      const decoded = create(Buffer.from(base64ToBytes(pack.assets[src.path].base64)));
      for (const definition of Object.values(theme.data.iconDefinitions)) if (definition.fontCharacter && (definition.fontId ?? theme.data.fonts?.[0]?.id) === font.id) {
        const code = decodeCharacter(definition.fontCharacter).codePointAt(0)!;
        if (!decoded.hasGlyphForCodePoint(code)) throw new Error(`Missing glyph ${definition.fontCharacter} in ${src.path}`);
        // Force outline decoding, not only the directory/signature.
        void decoded.glyphForCodePoint(code).path;
      }
    }
    console.log(JSON.stringify({ path, valid: true, id: pack.id, themes: pack.themes.map(t => ({ id: t.id, kind: t.kind })), warnings: pack.warnings }, null, 2));
  } catch (error) { console.error(`${path}: ${String(error)}`); process.exitCode = 1; }
}
