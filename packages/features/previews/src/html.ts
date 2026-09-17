import DOMPurify from "dompurify";
import { externalPreviewResource, previewResourcePolicy, resolvePreviewLink } from "./policy.js";
import { createPreviewResources, rewriteCss, type PreviewResourceOptions } from "./resources.js";
import bridgeSource from "./html-bridge.js?raw";

// The host CSP pins this script too; html.test.ts checks all host policies.
export const htmlPreviewScriptHash = "sha256-baG6zrI9qQ7n/0Uu0tcqeYXQC5vQ8ZWJY9nJ2PK7KPs=";

export { rewriteCss } from "./resources.js";
export const isHtmlPath = (path: string) => /\.html?$/i.test(path);

export async function prepareHtmlPreview(options: PreviewResourceOptions) {
  const { path, signal, trust = "local" } = options;
  const { text, resource, warnings } = createPreviewResources(options);

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
      const href = link.getAttribute("href") ?? "";
      const external = externalPreviewResource(href, trust);
      if (external) {
        link.setAttribute("href", external);
        link.setAttribute("referrerpolicy", "no-referrer");
        continue;
      }
      const target = resolvePreviewLink(path, href);
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
      } else warnings.add("External resources are blocked. Use the External resources control to allow them for this preview.");
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
  policy.content = `default-src 'none'; script-src '${htmlPreviewScriptHash}'; ${previewResourcePolicy(trust)}; base-uri 'none'; form-action 'none'`;
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  const referrer = document.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  document.head.prepend(policy, viewport, referrer);
  const bridge = document.createElement("script");
  bridge.textContent = bridgeSource;
  bridge.dataset.path = path;
  document.head.append(bridge);
  signal.throwIfAborted();
  return {
    html: "<!doctype html>\n" + document.documentElement.outerHTML,
    warnings: [...warnings],
    trust,
    scripts: /<script\b|\son\w+\s*=/i.test(source),
  };
}
