import { describe, expect, it } from "vitest";
import { fileTypesToSelectors, languageIdForPath, matchesFilePattern, resolveLanguage, selectorsMatch, selectorsToFileTypes, validateFileTypes } from "./languages.js";
import { validateFileAssociations, validateJson, validateLanguageServers } from "./language-servers.js";
import { textOffset, textPosition } from "./text-positions.js";
describe("shared language registry", () => {
  it.each([
    ["x.ts", "typescript"], ["x.mts", "typescript"], ["x.cts", "typescript"], ["x.tsx", "typescriptreact"], ["x.jsx", "javascriptreact"], ["x.cjs", "javascript"],
    ["README.markdown", "markdown"], ["README.mdx", "mdx"], ["welcome.blade.php", "blade"], ["index.htm", "html"], ["App.vue", "vue"], ["index.astro", "astro"],
    ["Dockerfile", "dockerfile"], ["Dockerfile.prod", "dockerfile"], ["prod.dockerfile", "dockerfile"], ["Containerfile", "dockerfile"], ["Containerfile.dev", "dockerfile"],
    ["ci.yaml", "yaml"], [".github/workflows/ci.yml", "yaml"], ["main.py", "python"], ["types.pyi", "python"],
    ["run.sh", "shellscript"], ["run.bash", "shellscript"], [".bashrc", "shellscript"], [".bash_profile", "shellscript"],
    [".zshrc", "zsh"], [".zshenv", "zsh"], [".zprofile", "zsh"], ["run.zsh", "zsh"],
    ["data.json", "json"], ["settings.jsonc", "jsonc"], ["data.jsonl", "jsonl"], ["data.ndjson", "jsonl"],
    ["Cargo.toml", "toml"], ["Cargo.lock", "toml"], [".cargo/config.toml", "toml"], [".cargo/config", "toml"], ["x.toml", "toml"],
    ["index.php", "php"], ["index.phtml", "php"], ["x.xml", "xml"], ["x.xsd", "xml"], ["x.xsl", "xml"], ["x.xslt", "xml"], ["x.svg", "xml"],
    ["x.ini", "ini"], [".env", "dotenv"], [".env.production", "dotenv"], ["prod.env", "dotenv"], ["data.csv", "csv"], ["server.log", "log"],
    ["x.conf", "plaintext"], ["x.cfg", "plaintext"], ["x.rs", "plaintext"],
  ])("resolves %s to %s", (file, id) => expect(resolveLanguage(file).id).toBe(id));
  it("orders explicit associations, filenames, extensions, then shebangs", () => {
    expect(resolveLanguage(".env.ts").id).toBe("dotenv");
    expect(resolveLanguage("Dockerfile.ts").id).toBe("dockerfile");
    expect(resolveLanguage("Dockerfile.ts", { associations: { "Dockerfile.*": "tsx" } }).id).toBe("typescriptreact");
    expect(resolveLanguage("tool", { firstLine: "#!/usr/bin/env -S zsh -f" }).id).toBe("zsh");
    expect(resolveLanguage("tool", { firstLine: "#!/bin/bash" }).id).toBe("shellscript");
    expect(resolveLanguage("tool", { firstLine: "#!/bin/sh -e" }).id).toBe("shellscript");
    expect(resolveLanguage("tool", { firstLine: "#!/usr/bin/env python3" }).id).toBe("python");
    expect(resolveLanguage("tool.zsh", { firstLine: "#!/bin/bash" }).id).toBe("zsh");
    expect(languageIdForPath("a.tsx")).toBe("tsx");
    expect(languageIdForPath("a.jsx")).toBe("javascript");
  });
  it("anchors workspace globs and treats regexp metacharacters literally", () => {
    expect(matchesFilePattern("**/.cargo/config.toml", ".cargo/config.toml")).toBe(true);
    expect(matchesFilePattern("src/*.foo", "src/nested/a.foo")).toBe(false);
    expect(matchesFilePattern("src/*.foo", "src/a.foo")).toBe(true);
    expect(matchesFilePattern("a[1].*", "a1.ts")).toBe(false);
  });
});
describe("file type selectors", () => {
  it("maps language IDs and globs to LSP selectors and back", () => {
    const selectors = fileTypesToSelectors(["yaml", " tsx ", "*.yml.j2", "deploy/*.conf", ".clang-format", ""]);
    expect(selectors).toEqual([{ language: "yaml" }, { language: "typescriptreact" }, { pattern: "*.yml.j2" }, { pattern: "deploy/*.conf" }, { pattern: ".clang-format" }]);
    expect(selectorsToFileTypes(selectors)).toEqual(["yaml", "typescriptreact", "*.yml.j2", "deploy/*.conf", ".clang-format"]);
    expect(selectorsMatch(selectors, "plaintext", "infra/site.yml.j2")).toBe(true);
    expect(selectorsMatch(selectors, "plaintext", "deploy/app.conf")).toBe(true);
    expect(selectorsMatch(selectors, "plaintext", "other/app.conf")).toBe(false);
    expect(selectorsMatch(selectors, "tsx", "a.tsx")).toBe(true);
    expect(selectorsMatch([{ language: "*" }], "python", "a.py")).toBe(true);
    expect(() => validateFileTypes(["yaml", "*.yml"])).not.toThrow();
    for (const value of [[""], [1], "yaml", ["x".repeat(1025)]]) expect(() => validateFileTypes(value)).toThrow();
  });
});
describe("structured settings validation", () => {
  it("accepts JSON and rejects lossy and cyclic values", () => {
    expect(() => validateJson({ list: [true, null, 1, { text: "x" }] })).not.toThrow();
    for (const value of [NaN, Infinity, undefined, () => {}, new Date(), { x: undefined }]) expect(() => validateJson(value)).toThrow();
    const cycle: any = {}; cycle.self = cycle;
    expect(() => validateJson(cycle)).toThrow();
    expect(() => validateJson(JSON.parse('{"__proto__":{}}'))).toThrow();
  });
  it("validates executable vectors, selectors, associations and credential boundaries", () => {
    expect(() => validateLanguageServers({ custom: { executable: "/a path/server", args: ["--stdio"], selectors: [{ language: "ini" }], env: { MODE: "test" } } })).not.toThrow();
    for (const config of [{ rootMarkers: ["../package.json"] }, { args: "--stdio" }, { settings: { intelephense: { licenceKey: "secret" } } }, { selectors: [{ scheme: "https" }] }, { unknown: 1 }]) expect(() => validateLanguageServers({ test: config })).toThrow();
    expect(() => validateFileAssociations({ "*.conf": "ini" })).not.toThrow();
    expect(() => validateFileAssociations({ "*.conf": 1 })).toThrow();
  });
});
describe("UTF-16 text positions", () => {
  it("maps Unicode and CRLF without treating code points as code units", () => {
    const text = "a😀\r\nβ\nlast";
    expect(textOffset(text, { line: 0, character: 3 })).toBe(3);
    expect(textOffset(text, { line: 1, character: 1 })).toBe(6);
    expect(textPosition(text, 5)).toEqual({ line: 1, character: 0 });
    expect(() => textOffset(text, { line: 0, character: 4 })).toThrow();
    expect(() => textPosition(text, -1)).toThrow();
  });
});
