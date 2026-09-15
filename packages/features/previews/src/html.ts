import DOMPurify from "dompurify";
import type { FileSystem } from "@oxbit/sdk";
import { resolvePreviewLink } from "./policy.js";
import bridgeSource from "./html-bridge.js?raw";

// The host CSP pins this script too; html.test.ts checks all host policies.
export const htmlPreviewScriptHash = "sha256-baG6zrI9qQ7n/0Uu0tcqeYXQC5vQ8ZWJY9nJ2PK7KPs=";

const types: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  bmp: "image/bmp", apng: "image/apng", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", mp4: "video/mp4", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
};
const maxBytes = 20 * 1024 * 1024;
const maxFiles = 128;

export const isHtmlPath = (path: string) => /\.html?$/i.test(path);

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

export async function prepareHtmlPreview(options: {
  path: string;
  readText(path: string): Promise<string>;
  filesystem: FileSystem;
  signal: AbortSignal;
  dependencies: Set<string>;
}) {
  const { path, readText, filesystem, signal, dependencies } = options;
  const warnings = new Set<string>();
  const cache = new Map<string, string>();
  let bytes = 0;
  const budget = (length: number) => {
    signal.throwIfAborted();
    bytes += length;
    if (bytes > maxBytes) throw new Error("HTML preview exceeds the 20 MB limit");
  };
  const text = async (file: string) => {
    dependencies.add(file);
    if (dependencies.size > maxFiles) throw new Error("HTML preview has too many linked files");
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
    const target = resolvePreviewLink(from, href);
    if (target.kind !== "file") {
      if (href) warnings.add(target.kind === "blocked" ? `${href}: ${target.reason}` : "Remote resources are not loaded in this local preview.");
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

  const source = await text(path);
  const clean = DOMPurify.sanitize(source, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["link"],
    FORBID_TAGS: ["script", "iframe", "frame", "frameset", "object", "embed", "base", "meta"],
    FORBID_ATTR: ["srcdoc", "ping", "action", "formaction", "target", "autofocus", "data-preview-href"],
  });
  const document = new DOMParser().parseFromString(clean, "text/html");
  for (const style of document.querySelectorAll("style"))
    style.textContent = await rewriteCss(style.textContent ?? "", (url, imported) => resource(path, url, imported));
  for (const link of document.querySelectorAll("link")) {
    if (link.rel.toLowerCase() === "stylesheet") {
      const style = document.createElement("style");
      const target = resolvePreviewLink(path, link.getAttribute("href") ?? "");
      if (target.kind === "file") {
        try {
          style.textContent = await rewriteCss(await text(target.path), (url, imported) =>
            resource(target.path, url, imported, [target.path]));
          if (link.media) style.media = link.media;
          link.replaceWith(style);
          continue;
        } catch (error) {
          signal.throwIfAborted();
          warnings.add(`Could not load ${target.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else warnings.add("Remote resources are not loaded in this local preview.");
    }
    link.remove();
  }
  for (const element of document.querySelectorAll("[style]"))
    element.setAttribute("style", await rewriteCss(element.getAttribute("style")!, (url, imported) => resource(path, url, imported)));
  for (const element of document.querySelectorAll("[src], [poster], image[href], image[xlink\\:href]")) {
    for (const attribute of ["src", "poster", "href", "xlink:href"]) {
      const value = element.getAttribute(attribute);
      if (value !== null) element.setAttribute(attribute, await resource(path, value));
    }
  }
  for (const element of document.querySelectorAll("[srcset]")) {
    // The browser parses data URL commas; retain those and resolve ordinary file candidates.
    const srcset = element.getAttribute("srcset")!;
    if (!srcset.trim().startsWith("data:")) {
      const candidates = [];
      for (const candidate of srcset.split(",")) {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        candidates.push(`${await resource(path, url ?? "")} ${descriptor.join(" ")}`.trim());
      }
      element.setAttribute("srcset", candidates.join(", "));
    }
  }
  for (const link of document.querySelectorAll("a[href], area[href]")) {
    link.setAttribute("data-preview-href", link.getAttribute("href")!);
    link.setAttribute("href", "#");
    link.removeAttribute("download");
  }
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = `default-src 'none'; script-src '${htmlPreviewScriptHash}'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'`;
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  document.head.prepend(policy, viewport);
  const bridge = document.createElement("script");
  bridge.textContent = bridgeSource;
  bridge.dataset.path = path;
  document.head.append(bridge);
  signal.throwIfAborted();
  return {
    html: "<!doctype html>\n" + document.documentElement.outerHTML,
    warnings: [...warnings],
    scripts: /<script\b|\son\w+\s*=/i.test(source),
  };
}
