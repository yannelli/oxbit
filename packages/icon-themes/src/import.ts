import { BlobReader, ZipReader } from "@zip.js/zip.js";
import { parse, type ParseError } from "jsonc-parser";
import manifestValidator from "./validate-manifest.js";
import fileValidator from "./validate-file.js";
import productValidator from "./validate-product.js";
import { bytesToBase64, decodeCharacter, validateAsset } from "./assets.js";
import type { Manifest, Pack, Theme, Associations } from "./types.js";
export const LIMITS = { compressed: 50 * 1024 ** 2, decompressed: 200 * 1024 ** 2, entries: 20_000, asset: 10 * 1024 ** 2, json: 5 * 1024 ** 2 };
export function safePath(path: string, from = ""): string {
  if (!path || /[\u0000-\u001f\u007f\\:%?#]/.test(path) || path.startsWith("/")) throw new Error(`Unsafe package path: ${path}`);
  const parts = from.split('/').filter(Boolean);
  for (const part of path.normalize('NFC').split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') { if (!parts.length) throw new Error(`Escaping package path: ${path}`); parts.pop(); }
    else parts.push(part);
  }
  if (!parts.length) throw new Error("Empty package path");
  return parts.join('/');
}
export function parseJson(bytes: Uint8Array, validator: typeof fileValidator, name: string): unknown {
  const errors: ParseError[] = [];
  const data = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`${name}: invalid JSONC at offset ${errors[0].offset}`);
  if (!validator(data)) throw new Error(`${name}: ${validator.errors?.slice(0, 4).map(e => `${e.instancePath} ${e.message}`).join('; ')}`);
  return data;
}
export const associationMaps = ['fileNames','fileExtensions','languageIds','folderNames','folderNamesExpanded','rootFolderNames','rootFolderNamesExpanded'] as const;
export function validateTheme(theme: Theme): void {
  const fonts = new Set<string>();
  for (const font of theme.fonts ?? []) { if (fonts.has(font.id)) throw new Error(`Duplicate font: ${font.id}`); fonts.add(font.id); }
  for (const def of Object.values(theme.iconDefinitions)) {
    if (def.fontCharacter) {
      decodeCharacter(def.fontCharacter);
      if (!fonts.has(def.fontId ?? theme.fonts?.[0]?.id ?? '')) throw new Error("Missing font definition");
    }
  }
  for (const associations of [theme, theme.light, theme.highContrast]) {
    if (!associations) continue;
    for (const key of ['file','folder','folderExpanded','rootFolder','rootFolderExpanded'] as const) {
      if (associations[key] && !Object.hasOwn(theme.iconDefinitions, associations[key]!)) throw new Error(`Missing icon definition: ${associations[key]}`);
    }
    for (const key of associationMaps) {
      const entries = associations[key];
      if (!entries) continue;
      const normalized: Record<string, string> = Object.create(null);
      for (const [name, id] of Object.entries(entries)) {
        if (!Object.hasOwn(theme.iconDefinitions, id)) throw new Error(`Missing icon definition: ${id}`);
        const lower = name.toLowerCase();
        if (Object.hasOwn(normalized, lower)) throw new Error(`Duplicate case-insensitive association: ${name}`);
        if (name.split('/').length > 2 || /[\\*?]/.test(name)) throw new Error(`Unsupported association: ${name}`);
        normalized[lower] = id;
      }
      associations[key] = normalized;
    }
  }
}
export async function importPack(blob: Blob, name: string, signal?: AbortSignal, limits = LIMITS): Promise<Pack> {
  if (!/\.(vsix|zip)$/i.test(name)) throw new Error("Choose a .zip or .vsix icon pack");
  if (blob.size > limits.compressed) throw new Error("Compressed archive exceeds limit");
  signal?.throwIfAborted();
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  const files = new Map<string, Uint8Array>(), paths = new Set<string>();
  let total = 0, count = 0, ignored = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > limits.entries) throw new Error("Archive entry count exceeds limit");
      const path = safePath(entry.filename);
      if (paths.has(path.toLowerCase())) throw new Error(`Duplicate normalized path: ${path}`);
      paths.add(path.toLowerCase());
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (entry.encrypted || mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000)) throw new Error("Encrypted or special archive entry");
      if (entry.directory) continue;
      const json = /\.json$/i.test(path), asset = /\.(svg|png|woff2?|ttf|otf)$/i.test(path);
      const legal = /(?:^|\/)(?:licen[sc]e|copying|notice|authors|attribution)[^/]*$/i.test(path);
      const keep = json || asset || legal;
      const max = json ? limits.json : limits.asset;
      if (entry.uncompressedSize > max) throw new Error(`${path}: entry exceeds limit`);
      let length = 0;
      const chunks: Uint8Array[] = [];
      let streamError: Error | undefined;
      try { await entry.getData(new WritableStream<Uint8Array>({ write(chunk) {
        signal?.throwIfAborted();
        length += chunk.length; total += chunk.length;
        if (length > max || total > limits.decompressed) { streamError = new Error("Actual decompressed output exceeds limit"); throw streamError; }
        if (keep) chunks.push(chunk.slice());
      }}), { signal, checkSignature: true }); } catch (error) { throw streamError ?? signal?.reason ?? error; }
      if (keep) { const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; } files.set(path, bytes); }
      else ignored++;
    }
  } finally { await reader.close(); }
  const root = /\.vsix$/i.test(name) ? 'extension/' : '';
  const manifestBytes = files.get(root + 'package.json');
  if (!manifestBytes) throw new Error(`Missing ${root}package.json`);
  const manifest = parseJson(manifestBytes, manifestValidator, 'package.json') as Manifest;
  const pack: Pack = { formatVersion: 1, id: `${manifest.publisher}.${manifest.name}`, revision: crypto.randomUUID(), label: manifest.displayName ?? manifest.name, publisher: manifest.publisher, version: manifest.version, license: manifest.license, description: manifest.description, enabled: true, themes: [], assets: Object.create(null), warnings: [] };
  if (ignored) pack.warnings.push(`${ignored} non-theme files ignored. Scripts and extension code are never executed.`);
  for (const key of Object.keys(manifest.contributes)) if (!['iconThemes','productIconThemes'].includes(key)) pack.warnings.push(`Ignored contribution: ${key}`);
  const read = (path: string) => { const bytes = files.get(root + path); if (!bytes) throw new Error(`Missing asset: ${path}`); return bytes; };
  const addAsset = (path: string) => { if (!Object.hasOwn(pack.assets, path)) { const bytes = read(path); pack.assets[path] = { mime: validateAsset(path, bytes), base64: bytesToBase64(bytes) }; } };
  for (const kind of ['fileIconTheme', 'productIconTheme'] as const) {
    const entries = manifest.contributes[kind === 'fileIconTheme' ? 'iconThemes' : 'productIconThemes'] ?? [];
    for (const entry of entries) {
      const id = `${pack.id}/${entry.id}`;
      if (pack.themes.some(t => t.id === id && t.kind === kind)) throw new Error(`Duplicate theme: ${id}`);
      const path = safePath(entry.path), dir = path.split('/').slice(0, -1).join('/');
      const data = parseJson(read(path), kind === 'fileIconTheme' ? fileValidator : productValidator, path) as Theme;
      validateTheme(data);
      for (const def of Object.values(data.iconDefinitions)) if (def.iconPath) { def.iconPath = safePath(def.iconPath, dir); addAsset(def.iconPath); }
      for (const font of data.fonts ?? []) for (const src of font.src) {
        src.path = safePath(src.path, dir); addAsset(src.path);
        const expected: Record<string, string> = { woff: 'font/woff', woff2: 'font/woff2', truetype: 'font/ttf', opentype: 'font/otf' };
        if (pack.assets[src.path].mime !== expected[src.format]) throw new Error('Font format does not match asset');
      }
      const known = new Set(['$schema','iconDefinitions','fonts', ...associationMaps,'file','folder','folderExpanded','rootFolder','rootFolderExpanded','light','highContrast','hidesExplorerArrows','showLanguageModeIcons']);
      for (const key of Object.keys(data)) if (!known.has(key)) { pack.warnings.push(`${entry.id}: unsupported feature ${key} ignored`); delete (data as unknown as Record<string, unknown>)[key]; }
      if (data.showLanguageModeIcons !== undefined) pack.warnings.push(`${entry.id}: language-contributed default images are not supported; language ID associations are supported.`);
      pack.themes.push({ id, kind, label: entry.label ?? entry.id, path, data });
    }
  }
  if (!pack.themes.length) throw new Error("No icon themes in this archive");
  for (const [path, bytes] of files) if (path.startsWith(root) && /(?:^|\/)(?:licen[sc]e|copying|notice|authors|attribution)[^/]*$/i.test(path)) pack.assets[path.slice(root.length)] = { mime: 'text/plain', base64: bytesToBase64(bytes) };
  signal?.throwIfAborted();
  return pack;
}
export function variantAssociations(theme: Theme, variant: string): Associations {
  const override = variant === 'highContrast' ? theme.highContrast : variant === 'light' ? theme.light : undefined;
  if (!override) return theme;
  const result = { ...theme, ...override };
  for (const key of associationMaps) result[key] = { ...theme[key], ...override[key] };
  return result;
}
