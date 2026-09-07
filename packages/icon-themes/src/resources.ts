import type { IconAsset } from "@oxbit/sdk";
import { base64ToBytes, decodeCharacter, validateAsset } from "./assets.js";
import type { Pack, StoredTheme } from "./types.js";
import { validateTheme } from "./import.js";
import fileValidator from "./validate-file.js";
import productValidator from "./validate-product.js";
export class PackResources {
  private urls = new Map<string, string>();
  private fonts = new Map<string, FontFace>();
  private disposed = false;
  constructor(readonly pack: Pack) {}
  async load(signal?: AbortSignal): Promise<void> {
    if (this.pack.formatVersion !== 1 || !/^[\w.-]+\.[\w.-]+$/.test(this.pack.id) || !Array.isArray(this.pack.themes) || !this.pack.themes.length) throw new Error('Corrupt icon pack metadata');
    try {
      const fontCache = new Map<string, FontFace>();
      let expandedFonts = 0;
      for (const [path, asset] of Object.entries(this.pack.assets)) {
        signal?.throwIfAborted();
        if (asset.mime === 'text/plain') continue;
        const bytes = base64ToBytes(asset.base64);
        if (bytes.length > 10 * 1024 ** 2 || validateAsset(path, bytes) !== asset.mime) throw new Error(`Corrupt icon asset: ${path}`);
        if (asset.mime.startsWith('font/')) {
          expandedFonts += asset.mime.startsWith('font/woff') ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16) : bytes.length;
          if (expandedFonts > 200 * 1024 ** 2) throw new Error('Decoded font data exceeds limit');
        }
        if (asset.mime === 'image/png' && typeof createImageBitmap !== 'undefined') {
          const bitmap = await createImageBitmap(new Blob([bytes as BlobPart])); bitmap.close();
        }
      }
      for (const theme of this.pack.themes) {
        const validator = theme.kind === 'fileIconTheme' ? fileValidator : productValidator;
        if (!validator(theme.data) || !theme.id.startsWith(this.pack.id + '/')) throw new Error('Corrupt icon theme');
        validateTheme(theme.data);
        for (const def of Object.values(theme.data.iconDefinitions)) if (def.iconPath && !this.pack.assets[def.iconPath]?.mime.startsWith('image/')) throw new Error('Missing image');
        for (const font of theme.data.fonts ?? []) {
          for (const src of font.src) if (!this.pack.assets[src.path]?.mime.startsWith('font/')) throw new Error('Missing font');
          if (typeof FontFace === 'undefined') continue;
          const cacheKey = JSON.stringify([font.src, font.weight, font.style]);
          const cached = fontCache.get(cacheKey);
          if (cached) { this.fonts.set(`${theme.kind}:${theme.id}:${font.id}`, cached); continue; }
          let face: FontFace | undefined;
          for (const src of font.src) {
            signal?.throwIfAborted();
            const bytes = base64ToBytes(this.pack.assets[src.path].base64);
            const candidate = new FontFace(`oxbit-icons-${crypto.randomUUID()}`, bytes as unknown as ArrayBuffer, { weight: font.weight ?? 'normal', style: font.style ?? 'normal' });
            try { await candidate.load(); face ??= candidate; } catch { throw new Error(`Font decoding failed: ${src.path}`); }
          }
          if (face) { fontCache.set(cacheKey, face); this.fonts.set(`${theme.kind}:${theme.id}:${font.id}`, face); document.fonts.add(face); }
        }
      }
      signal?.throwIfAborted();
      if (this.disposed) throw new Error('Icon resources disposed');
    } catch (error) { this.dispose(); throw error; }
  }
  asset(theme: StoredTheme, id: string): IconAsset | undefined {
    if (this.disposed) return;
    const def = theme.data.iconDefinitions[id];
    if (!def) return;
    if (def.iconPath) {
      const source = this.pack.assets[def.iconPath];
      if (!source) return;
      let url = this.urls.get(def.iconPath);
      if (!url) {
        url = URL.createObjectURL(new Blob([base64ToBytes(source.base64) as BlobPart], { type: source.mime })); this.urls.set(def.iconPath, url);
      }
      return { kind: 'image', url };
    }
    const font = theme.data.fonts?.find(f => f.id === (def.fontId ?? theme.data.fonts?.[0]?.id));
    const face = font && this.fonts.get(`${theme.kind}:${theme.id}:${font.id}`);
    if (!face || !def.fontCharacter) return;
    const file = theme.kind === 'fileIconTheme';
    const generic = theme.data.file ? theme.data.iconDefinitions[theme.data.file] : undefined;
    return { kind: 'font', family: face.family, character: decodeCharacter(def.fontCharacter), weight: font.weight, style: font.style, color: file ? def.fontColor ?? generic?.fontColor : undefined, size: file ? def.fontSize ?? generic?.fontSize ?? font.size : undefined };
  }
  dispose() {
    this.disposed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    for (const face of new Set(this.fonts.values())) document.fonts.delete(face);
    this.urls.clear(); this.fonts.clear();
  }
}
