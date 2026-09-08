import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { WorkspaceFiles } from "../../apps/runtime/src/filesystem.js";
import { LanguageServerManager } from "../../apps/runtime/src/lsp-manager.js";
import { textOffset, textPosition } from "../../packages/sdk/src/text-positions.js";
const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-language-features-"));
const diagnostics = new Map<string, { version: number; diagnostics: any[] }>();
const manager = new LanguageServerManager(new WorkspaceFiles(root), process.env.OXBIT_LSP_CACHE ?? path.join(os.tmpdir(), "oxbit-managed-language-smoke-cache"), (method, params) => {
  if (process.env.OXBIT_LSP_TRACE && method === "window/logMessage") console.log(params.message);
  if (method === "textDocument/publishDiagnostics") diagnostics.set(params.uri, params);
});
const results: { feature: string; passed: boolean }[] = [];
async function open(id: string, file: string, text: string, settings: any = {}) {
  await fs.writeFile(path.join(root, file), text); manager.canonical(file, text);
  await manager.watched(file, 1);
  const attached = await manager.attach(file, "fixture", settings, {}, id); await manager.start(false, attached.instanceId);
  const textDocument = { uri: pathToFileURL(path.join(root, file)).href };
  return { id: attached.instanceId, request: (method: string, params: any) => manager.request(method, { textDocument, ...params }, undefined, undefined, attached.instanceId) };
}
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20000;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error("Server indexing did not produce the expected result"); await new Promise(resolve => setTimeout(resolve, 100)); }
}
function pass(feature: string) { results.push({ feature, passed: true }); console.log(`PASS ${feature}`); }
try {
  await fs.writeFile(path.join(root, "package.json"), '{"name":"language-fixture","private":true}');
  await fs.writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true,"target":"ES2022","moduleResolution":"bundler","module":"ESNext"},"include":["*.ts","*.vue","*.astro"]}');
  const html = await open("html", "index.html", "<di");
  const htmlCompletion = await html.request("textDocument/completion", { position: { line: 0, character: 3 }, context: { triggerKind: 1 } });
  assert(htmlCompletion.items.some((item: any) => item.label === "div")); pass("HTML tag completion");
  const json = await open("json", "config.json", '{\n  ""\n}', { json: { settings: { json: { schemas: [{ fileMatch: ["config.json"], schema: { type: "object", properties: { welcome: { type: "string" } } } }] } } } });
  const jsonCompletion = await json.request("textDocument/completion", { position: { line: 1, character: 3 } });
  assert(jsonCompletion.items.some((item: any) => item.label === "welcome")); pass("JSON schema completion");
  const php = await open("intelephense", "main.php", "<?php\nstrlen(");
  const phpSignature = await eventually(() => php.request("textDocument/signatureHelp", { position: { line: 1, character: 7 } }), value => Boolean(value?.signatures?.length));
  assert(phpSignature.signatures.some((item: any) => item.parameters?.length && item.label.includes("string"))); pass("PHP free signature help");
  const ts = await open("typescript", "main.ts", 'export function greet(name: string, count = 1) { return name.repeat(count); }\nconst message = greet("world", 2);\nmessage.toUpperCase();\n');
  const signature = await ts.request("textDocument/signatureHelp", { position: { line: 1, character: 22 } });
  assert(signature.signatures[0].label.includes("greet")); pass("TypeScript signatures");
  const tokens = await ts.request("textDocument/semanticTokens/full", {}); assert(tokens.data.length > 0 && tokens.data.length % 5 === 0); pass("TypeScript semantic tokens");
  const hints = await ts.request("textDocument/inlayHint", { range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } } });
  assert(hints.some((hint: any) => hint.kind === 1) && hints.some((hint: any) => hint.kind === 2)); pass("TypeScript type and parameter inlay hints");
  const definitions = await ts.request("textDocument/definition", { position: { line: 2, character: 12 } });
  const location = Array.isArray(definitions) ? definitions[0] : definitions;
  const grant = await manager.authorizeExternal(location.uri ?? location.targetUri, ts.id), external = await manager.readExternal(grant.handle, ts.id);
  assert(external.readonly && external.text.includes("toUpperCase")); pass("Read-only bundled TypeScript SDK navigation");
  await fs.writeFile(path.join(root, "helpers.ts"), 'export function welcomeUser(name: string) { return "Hello " + name; }');
  const imports = await open("typescript", "imports.ts", 'welcomeUs');
  const imported = await eventually(() => imports.request("textDocument/completion", { position: { line: 0, character: 9 }, context: { triggerKind: 1 } }), value => (Array.isArray(value) ? value : value?.items ?? []).some((item: any) => item.label === "welcomeUser"));
  const importItem = (Array.isArray(imported) ? imported : imported.items).find((item: any) => item.label === "welcomeUser");
  const resolvedImport = await imports.request("completionItem/resolve", importItem);
  assert(resolvedImport.additionalTextEdits?.some((edit: any) => edit.newText.includes("import") && edit.newText.includes("welcomeUser"))); pass("TypeScript resolved auto-import edits");
  const vue = await open("vue", "App.vue", '<script setup lang="ts">\nconst message = "hello";\nmessage.\n</script>\n<template><div /></template>');
  const vueCompletion = await vue.request("textDocument/completion", { position: { line: 2, character: 8 }, context: { triggerKind: 2, triggerCharacter: "." } });
  assert((Array.isArray(vueCompletion) ? vueCompletion : vueCompletion.items).some((item: any) => item.label === "toUpperCase")); pass("Vue TypeScript bridge completion");
  const vueImport = await open("vue", "Import.vue", '<script setup lang="ts">\nwelcomeUs\n</script>\n<template><div /></template>');
  const vueImported = await eventually(() => vueImport.request("textDocument/completion", { position: { line: 1, character: 9 }, context: { triggerKind: 1 } }), value => (Array.isArray(value) ? value : value?.items ?? []).some((item: any) => item.label === "welcomeUser"));
  const vueImportItem = (Array.isArray(vueImported) ? vueImported : vueImported.items).find((item: any) => item.label === "welcomeUser");
  const vueResolvedImport = await vueImport.request("completionItem/resolve", vueImportItem);
  assert(vueResolvedImport.additionalTextEdits?.some((edit: any) => edit.newText.includes("import") && edit.newText.includes("welcomeUser"))); pass("Vue resolved auto-import edits");
  let astroText = ["---", '// 😀 source positions', 'const message: string = "hello";', 'const broken: number = "wrong";', 'message.toUpperCase();', '---', '<h1>{message.toUpperCase()}</h1>', '<script>', 'const client: string = "hello";', 'const clientBroken: number = "wrong";', 'client.toUpperCase();', '</script>', '<style>', 'h1 { color: red; }', '</style>', ''].join("\r\n");
  const astro = await open("astro", "index.astro", astroText);
  const astroUri = pathToFileURL(path.join(root, "index.astro")).href;
  const astroPosition = (marker: string, advance = 0) => {
    const index = astroText.indexOf(marker); assert(index >= 0, `Missing Astro marker: ${marker}`);
    return textPosition(astroText, index + advance);
  };
  for (const [region, marker, advance, label] of [
    ["frontmatter", "message.toUpperCase();", 8, "toUpperCase"],
    ["template expression", "{message.toUpperCase()}", 9, "toUpperCase"],
    ["script", "client.toUpperCase();", 7, "toUpperCase"],
    ["HTML", "<h1>", 2, "h1"],
    ["CSS", "color: red", 3, "color"],
  ] as const) {
    const position = astroPosition(marker, advance);
    const completion = await astro.request("textDocument/completion", { position, context: { triggerKind: 1 } });
    const item = (Array.isArray(completion) ? completion : completion.items).find((item: any) => item.label === label);
    assert(item, `Missing ${region} completion`);
    const resolved = await astro.request("completionItem/resolve", item);
    assert(resolved.documentation || resolved.detail, `Missing ${region} documentation`);
    const editRange = resolved.textEdit?.range ?? resolved.textEdit?.insert;
    assert.equal(editRange?.start.line, position.line, `${region} edit must target the source line`);
    const hover = await astro.request("textDocument/hover", { position: { ...position, character: position.character + 1 } });
    assert(hover?.contents && hover.range?.start.line === position.line, `${region} hover must target the source line`);
    pass(`Astro ${region} completion, resolution and hover`);
  }
  async function checkAstroMappings() {
    const templatePosition = astroPosition("{message.", 2);
    const definitions = await astro.request("textDocument/definition", { position: templatePosition });
    const locations = Array.isArray(definitions) ? definitions : [definitions];
    assert(locations.some((item: any) => (item.uri ?? item.targetUri) === astroUri && (item.range ?? item.targetSelectionRange).start.line === astroPosition("const message").line));
    const version = manager.versions(astro.id)[astroUri];
    const report = await eventually(async () => diagnostics.get(astroUri), value => value?.version === version && ["const broken", "const clientBroken"].every(marker => value.diagnostics.some(item => item.code === 2322 && item.range.start.line === astroPosition(marker).line)));
    assert(report);
    const rename = await astro.request("textDocument/rename", { position: templatePosition, newName: "greeting" });
    const edits = rename.changes?.[astroUri] ?? rename.documentChanges?.flatMap((change: any) => change.textDocument?.uri === astroUri ? change.edits : []) ?? [];
    assert.equal(edits.length, 3);
    assert(edits.every((edit: any) => astroText.slice(textOffset(astroText, edit.range.start), textOffset(astroText, edit.range.end)) === "message"));
  }
  await checkAstroMappings(); pass("Astro cross-region navigation, rename and diagnostics");
  astroText = astroText.replace("// 😀 source positions", "// unsaved change\r\n// 😀 source positions");
  manager.canonical("index.astro", astroText);
  await checkAstroMappings(); pass("Astro mappings after unsaved CRLF edits");
  diagnostics.delete(astroUri);
  await manager.restart(astro.id);
  await checkAstroMappings(); pass("Astro mixed-language restart replay");
  const astroImportText = '---\n// 😀 keep imports inside frontmatter\nwelcomeUs\n---\n<h1>Hello</h1>\n';
  const astroImport = await open("astro", "Import.astro", astroImportText);
  const astroImported = await eventually(() => astroImport.request("textDocument/completion", { position: { line: 2, character: 9 }, context: { triggerKind: 1 } }), value => (Array.isArray(value) ? value : value?.items ?? []).some((item: any) => item.label === "welcomeUser"));
  const astroImportItem = (Array.isArray(astroImported) ? astroImported : astroImported.items).find((item: any) => item.label === "welcomeUser");
  const astroResolved = await astroImport.request("completionItem/resolve", astroImportItem);
  const importEdit = astroResolved.additionalTextEdits?.find((edit: any) => edit.newText.includes("import") && edit.newText.includes("welcomeUser"));
  assert(importEdit);
  const importOffset = textOffset(astroImportText, importEdit.range.start);
  assert(importOffset >= 3 && importOffset < astroImportText.indexOf("\n---", 3));
  assert.equal(astroResolved.textEdit.insert.start.line, 2);
  pass("Astro resolved auto-import edits stay inside frontmatter");
  const cargo = await open("taplo", "Cargo.toml", '[package]\nname = "fixture"\nversion = "0.1.0"\n');
  const cargoAssociation = await eventually(() => cargo.request("taplo/associatedSchema", { documentUri: pathToFileURL(path.join(root, "Cargo.toml")).href }), value => Boolean(value?.schema?.url));
  assert(cargoAssociation.schema.url.endsWith("/schemas/cargo.json"));
  await fs.mkdir(path.join(root, ".cargo"));
  const cargoConfig = await open("taplo", ".cargo/config.toml", '[build]\njobs = 2\n');
  const configAssociation = await eventually(() => cargoConfig.request("taplo/associatedSchema", { documentUri: pathToFileURL(path.join(root, ".cargo/config.toml")).href }), value => Boolean(value?.schema?.url));
  assert(configAssociation.schema.url.endsWith("/schemas/cargo-config.json"));
  const cargoLock = await open("taplo", "Cargo.lock", 'version = 4\n');
  const lockAssociation = await cargoLock.request("taplo/associatedSchema", { documentUri: pathToFileURL(path.join(root, "Cargo.lock")).href });
  assert(!lockAssociation?.schema); pass("Separate Cargo manifest/config schemas and unassociated lockfile");
} finally {
  await manager.dispose(); await fs.rm(root, { recursive: true, force: true });
  if (process.env.OXBIT_LSP_REPORT) await fs.writeFile(process.env.OXBIT_LSP_REPORT, JSON.stringify({ platform: `${process.platform}-${process.arch}`, results }, null, 2) + "\n");
}
