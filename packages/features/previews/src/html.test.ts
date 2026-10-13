import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { htmlPreviewScriptHash, isHtmlPath, rewriteCss } from "./html.js";

describe("HTML preview CSS resources", () => {
  it("pins only the bundled navigation script in every host policy", () => {
    const bridge = readFileSync(new URL("./html-bridge.js", import.meta.url));
    const hash = "sha256-" + createHash("sha256").update(bridge).digest("base64");
    expect(htmlPreviewScriptHash).toBe(hash);
    for (const file of ["apps/runtime/src/runtime.ts", "apps/ios/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/tauri.conf.json"])
      expect(readFileSync(new URL("../../../../" + file, import.meta.url), "utf8")).toContain(`'${hash}'`);
  });
  it("serves the script preview shell outside each host's script policy", () => {
    const read = (file: string) => readFileSync(new URL("../../../../" + file, import.meta.url), "utf8");
    for (const file of ["apps/ios/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/tauri.conf.json"])
      expect(read(file)).toMatch(/frame-src [^;]*oxbit-preview: http:\/\/oxbit-preview\.localhost;/);
    for (const file of ["apps/ios/src-tauri/src/lib.rs", "apps/desktop/src-tauri/src/main.rs"]) {
      expect(read(file)).toContain('.register_uri_scheme_protocol("oxbit-preview", preview_shell)');
      expect(read(file)).toContain('include_str!("../../../web/public/preview-shell.html")');
    }
    expect(read("apps/runtime/src/runtime.ts")).toContain(`path.join(webRoot, "preview-shell.html") ? "frame-ancestors 'self'"`);
    expect(read("apps/web/public/preview-shell.html")).toContain('event.source !== parent');
  });
  it("resolves imports, escaped paths, fonts and images while retaining media rules", async () => {
    const urls: [string, boolean][] = [];
    const result = await rewriteCss(`@import "layout.css" screen;
@import url('colors.css');
/* url(do-not-read.png) */
@font-face { src: url(fonts/body.woff2) format('woff2') }
main { background: url("images/my\\20 image.svg#mark"); mask: url(#mask) }`, async (url, stylesheet) => {
      urls.push([url, stylesheet]);
      return `resolved:${url}`;
    });
    expect(urls).toEqual([
      ["layout.css", true], ["colors.css", true], ["fonts/body.woff2", false],
      ["images/my image.svg#mark", false], ["#mask", false],
    ]);
    expect(result).toContain('@import url("resolved:layout.css") screen;');
    expect(result).toContain("/* url(do-not-read.png) */");
    expect(result).toContain("format('woff2')");
  });

  it("recognizes HTML filenames without matching similarly named non-HTML files", () => {
    expect(isHtmlPath("site/INDEX.HTML")).toBe(true);
    expect(isHtmlPath("site/index.htm")).toBe(true);
    expect(isHtmlPath("index.html.ts")).toBe(false);
  });
});
