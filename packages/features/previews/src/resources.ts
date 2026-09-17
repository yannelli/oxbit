import type { FileSystem } from "@oxbit/sdk";
import { externalPreviewResource, resolvePreviewLink, type PreviewResourceTrust } from "./policy.js";

const types: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  bmp: "image/bmp", apng: "image/apng", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", mp4: "video/mp4", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
};
const maxBytes = 20 * 1024 * 1024;
const maxFiles = 128;

/** Replace CSS resources without changing media queries or declaration order. */
export async function rewriteCss(
  css: string,
  resolve: (url: string, stylesheet: boolean) => Promise<string>,
): Promise<string> {
  const pattern = /\/\*[\s\S]*?\*\/|(?:@import\s+)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*?))\s*\)/gi;
  let result = "", offset = 0;
  for (const match of css.matchAll(pattern)) {
    result += css.slice(offset, match.index);
    offset = match.index! + match[0].length;
    if (match[0].startsWith("/*")) {
      result += match[0];
      continue;
    }
    const stylesheet = /^@import/i.test(match[0]) || /@import\s*$/i.test(css.slice(0, match.index));
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "")
      .replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex: string, char: string) =>
        hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char);
    const url = await resolve(value, stylesheet);
    result += `${/^@import/i.test(match[0]) ? "@import " : ""}url(${JSON.stringify(url)})`;
  }
  return result + css.slice(offset);
}

export interface PreviewResourceOptions {
  path: string;
  readText(path: string): Promise<string>;
  filesystem: FileSystem;
  signal: AbortSignal;
  dependencies: Set<string>;
  trust?: PreviewResourceTrust;
}

export function createPreviewResources(options: PreviewResourceOptions) {
  const { readText, filesystem, signal, dependencies, trust = "local" } = options;
  const warnings = new Set<string>();
  const cache = new Map<string, string>();
  let bytes = 0;
  const budget = (length: number) => {
    signal.throwIfAborted();
    bytes += length;
    if (bytes > maxBytes) throw new Error("Preview exceeds the 20 MB limit");
  };
  const text = async (file: string) => {
    dependencies.add(file);
    if (dependencies.size > maxFiles) throw new Error("Preview has too many linked files");
    const value = await readText(file);
    budget(value.length * 2);
    return value;
  };
  const dataUrl = (data: Uint8Array, mime: string) => {
    let binary = "";
    for (let offset = 0; offset < data.length; offset += 8192)
      binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
    return `data:${mime};base64,${btoa(binary)}`;
  };
  const resource = async (from: string, href: string, stylesheet = false, ancestors: string[] = []): Promise<string> => {
    signal.throwIfAborted();
    if (/^data:(?:image|font|audio|video)\//i.test(href) && !stylesheet) return href;
    if (href.startsWith("#") && !stylesheet) return href;
    const external = externalPreviewResource(href, trust);
    if (external) return external;
    const target = resolvePreviewLink(from, href);
    if (target.kind !== "file") {
      if (href) warnings.add(target.kind === "blocked" ? `${href}: ${target.reason}` : "External resources are blocked. Use the External resources control to allow them for this preview.");
      return "data:,";
    }
    const file = target.path;
    dependencies.add(file);
    try {
      if (ancestors.includes(file) || ancestors.length >= 12)
        throw new Error("Circular or deeply nested stylesheet import");
      if (dependencies.size > maxFiles) throw new Error("Too many linked files");
      const key = `${stylesheet ? "css:" : "asset:"}${file}`;
      let url = cache.get(key);
      if (!url) {
        if (stylesheet) {
          const css = await rewriteCss(await text(file), (url, imported) =>
            resource(file, url, imported, [...ancestors, file]));
          url = dataUrl(new TextEncoder().encode(css), "text/css");
        } else {
          const mime = types[file.split(".").pop()!.toLowerCase()];
          if (!mime || !filesystem.readBytes) throw new Error("Unsupported resource type");
          const data = await filesystem.readBytes(file, signal);
          budget(data.byteLength);
          url = dataUrl(data, mime);
        }
        cache.set(key, url);
      }
      return url + (target.anchor ? `#${encodeURIComponent(target.anchor)}` : "");
    } catch (error) {
      signal.throwIfAborted();
      warnings.add(`Could not load ${file}: ${error instanceof Error ? error.message : String(error)}`);
      return "data:,";
    }
  };

  return { text, resource, warnings };
}
