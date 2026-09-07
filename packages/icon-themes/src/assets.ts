import { SaxesParser } from "saxes";
export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export function decodeCharacter(value: string): string {
  const match = /^\\([a-f\d]{1,6})$/i.exec(value);
  const code = match ? parseInt(match[1], 16) : value.codePointAt(0)!;
  if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (!match && [...value].length !== 1)) throw new Error("Invalid font character");
  return String.fromCodePoint(code);
}
const tags = new Set('svg g path rect circle ellipse line polyline polygon defs clipPath mask linearGradient radialGradient stop title desc use symbol'.split(' '));
export function validateSvg(bytes: Uint8Array): void {
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let root = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => { throw new Error("SVG doctypes are not supported"); });
  parser.on("processinginstruction", () => { throw new Error("Active SVG processing instruction"); });
  parser.on("opentag", tag => {
    if (!root && tag.local !== "svg") throw new Error("Invalid SVG root");
    root = true;
    if (!tags.has(tag.local) || (tag.uri && tag.uri !== "http://www.w3.org/2000/svg")) throw new Error(`Unsupported SVG element: ${tag.name}`);
    for (const attr of Object.values(tag.attributes)) {
      const value = attr.value;
      if (attr.prefix === "xmlns" || attr.name === "xmlns") continue;
      if (attr.name === "xml:base") throw new Error("SVG base overrides are not supported");
      if (/^on/i.test(attr.local) || !/^[\w:-]+$/.test(attr.name)) throw new Error("Active SVG attribute");
      if (attr.local === "href" && !/^#[\w.-]+$/.test(value)) throw new Error("External SVG reference");
      // No CSS escapes, comments, imports, script expressions or external URLs.
      if (/[\\@]|\/\*|(?:javascript|data|https?|file):|expression\s*\(/i.test(value)) throw new Error("Unsafe SVG attribute value");
      if (/url\s*\(/i.test(value) && /url\s*\([^)]*\)/gi.test(value.replace(/url\s*\(\s*['"]?#[\w.-]+['"]?\s*\)/gi, ""))) throw new Error("External SVG URL");
      if (attr.local === "style" && /[{}<>]/.test(value)) throw new Error("Invalid SVG style");
      if ((attr.local === "width" || attr.local === "height") && parseFloat(value) > 4096) throw new Error("SVG dimensions exceed 4096");
    }
  });
  parser.on("error", error => { throw error; });
  parser.write(xml).close();
  if (!root) throw new Error("Empty SVG");
}
export function validateAsset(path: string, bytes: Uint8Array): string {
  const ext = path.split('.').pop()!.toLowerCase();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = new TextDecoder().decode(bytes.subarray(0, 4));
  if (ext === "svg") { validateSvg(bytes); return "image/svg+xml"; }
  if (ext === "png") {
    if (bytes.length < 45 || bytes.slice(0, 8).join() !== "137,80,78,71,13,10,26,10") throw new Error("Invalid PNG signature");
    if (new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR" || view.getUint32(8) !== 13) throw new Error("Invalid PNG header");
    const w = view.getUint32(16), h = view.getUint32(20);
    if (!w || !h || w > 4096 || h > 4096 || w * h > 4_194_304) throw new Error("PNG dimensions exceed limit");
    let offset = 8, end = false, data = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), tag = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
      offset += length + 12;
      if (offset > bytes.length) throw new Error("Truncated PNG");
      if (tag === "IDAT") data = true;
      if (tag === "IEND") { end = length === 0; break; }
    }
    if (!data || !end || offset !== bytes.length) throw new Error("Invalid PNG chunks");
    return "image/png";
  }
  const formats: Record<string, string> = { woff: "wOFF", woff2: "wOF2", otf: "OTTO", ttf: "\u0000\u0001\u0000\u0000" };
  if (!formats[ext] || signature !== formats[ext]) throw new Error(`Invalid or unsupported asset: ${path}`);
  if (ext.startsWith("woff")) {
    if (bytes.length < (ext === "woff" ? 44 : 48) || view.getUint32(8) !== bytes.length || !view.getUint16(12) || view.getUint32(16) > 10 * 1024 * 1024) throw new Error("Invalid font header");
    if (ext === "woff") {
      const count = view.getUint16(12);
      if (44 + count * 20 > bytes.length) throw new Error("Truncated WOFF directory");
      for (let i = 0; i < count; i++) {
        const at = 44 + i * 20, start = view.getUint32(at + 4), length = view.getUint32(at + 8);
        if (start + length > bytes.length || length > view.getUint32(at + 12)) throw new Error("Invalid WOFF table");
      }
    }
  } else {
    if (bytes.length < 12 || !view.getUint16(4) || 12 + view.getUint16(4) * 16 > bytes.length) throw new Error("Invalid font directory");
    for (let i = 0; i < view.getUint16(4); i++) {
      const at = 12 + i * 16;
      if (view.getUint32(at + 8) + view.getUint32(at + 12) > bytes.length) throw new Error("Truncated font table");
    }
  }
  return `font/${ext}`;
}
