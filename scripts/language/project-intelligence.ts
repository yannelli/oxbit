import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceFiles } from "../../apps/runtime/src/filesystem.js";
import { LanguageServerManager } from "../../apps/runtime/src/lsp-manager.js";
import { ProjectStore } from "../../apps/runtime/src/projects.js";

const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-project-intelligence-"));
const cache = process.env.OXBIT_LSP_CACHE ?? path.join(os.tmpdir(), "oxbit-managed-language-smoke-cache");
const files = new WorkspaceFiles(root);
const project = await new ProjectStore(files, root + "-projects").initialize();
const reports: { feature: string; passed: boolean }[] = [];
const diagnostics = new Map<string, any>();
const manager = new LanguageServerManager(files, cache, (method, params) => {
  if (method === "textDocument/publishDiagnostics") diagnostics.set(params.uri, params);
  if (method === "window/logMessage") console.log(params.message);
  if (method === "oxbit/serverState" && params.error) console.error(params.error);
}, 300_000, project);
async function open(id: string, file: string, text: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text); manager.canonical(file, text);
  const attached = await manager.attach(file, "fixture", {}, {}, id);
  await manager.start(false, attached.instanceId);
  const textDocument = { uri: pathToFileURL(path.join(root, file)).href };
  return { id: attached.instanceId, uri: textDocument.uri, request: (method: string, params: any) => manager.request(method, { textDocument, ...params }, undefined, undefined, attached.instanceId) };
}
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20000;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error("Server did not produce the expected result: " + JSON.stringify(value).slice(0, 1000)); await new Promise(resolve => setTimeout(resolve, 100)); }
}
function pass(feature: string) { reports.push({ feature, passed: true }); console.log(`PASS ${feature}`); }
try {
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, jsx: "preserve", moduleResolution: "bundler", module: "esnext" }, include: ["**/*"] }));
  const json = await open("json", "package.json", '{\n  ""\n}');
  const completion = await eventually(() => json.request("textDocument/completion", { position: { line: 1, character: 3 } }), value => value.items.some((item: any) => item.label === "dependencies"));
  assert(completion.items.some((item: any) => item.label === "dependencies")); pass("Automatic SchemaStore package.json completion");
  manager.canonical("package.json", '{"name": 123}');
  await eventually(async () => diagnostics.get(json.uri), report => report?.diagnostics.some((item: any) => item.message.includes("string")));
  pass("Automatic SchemaStore validation");
  await fs.writeFile(path.join(root, "schema-child.json"), '{"type":"object","properties":{"welcome":{"type":"string","description":"A local greeting"}}}');
  await fs.writeFile(path.join(root, "schema.json"), '{"$ref":"./schema-child.json"}');
  const local = await open("json", "settings.json", '{\n  "$schema": "./schema.json",\n  ""\n}');
  const localCompletion = await local.request("textDocument/completion", { position: { line: 2, character: 3 } });
  assert(localCompletion.items.some((item: any) => item.label === "welcome")); pass("Workspace $schema and nested relative $ref completion");
  await fs.writeFile(path.join(root, "schema-child.json"), '{"type":"object","properties":{"updated":{"type":"number"}}}');
  await manager.watched("schema-child.json", 2);
  await eventually(() => local.request("textDocument/completion", { position: { line: 2, character: 3 } }), value => value.items.some((item: any) => item.label === "updated"));
  pass("Local schema edits invalidate cached validation and completion");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture","private":true}'); manager.canonical("package.json", '{"name":"fixture","private":true}');
  await fs.writeFile(path.join(root, "helper.ts"), 'export function welcome(name: string) { return "Hello " + name; }');
  const mdxText = 'import { welcome } from "./helper.js"\n\nexport const message = "hello"\n\n# Hello\n\n{message.toUpperCase()}\n\n{welcome("world")}\n';
  const mdx = await open("mdx", "README.mdx", mdxText);
  const mdxCompletion = await eventually(() => mdx.request("textDocument/completion", { position: { line: 6, character: 11 }, context: { triggerKind: 1 } }), value => (value?.items ?? value ?? []).some((item: any) => item.label === "toUpperCase"));
  const resolved = await mdx.request("completionItem/resolve", mdxCompletion.items.find((item: any) => item.label === "toUpperCase"));
  assert(resolved.documentation || resolved.detail); pass("MDX embedded JavaScript completion and resolution");
  const hover = await mdx.request("textDocument/hover", { position: { line: 6, character: 3 } });
  assert(hover?.contents); pass("MDX hover");
  const definition = await mdx.request("textDocument/definition", { position: { line: 8, character: 4 } });
  assert((Array.isArray(definition) ? definition : [definition]).some((item: any) => (item?.uri ?? item?.targetUri)?.endsWith("/helper.ts"))); pass("MDX cross-file definition");
  await manager.restart(mdx.id);
  const replay = await mdx.request("textDocument/hover", { position: { line: 6, character: 3 } }); assert(replay?.contents); pass("MDX restart replay");
  await fs.mkdir(path.join(root, "laravel"));
  await fs.writeFile(path.join(root, "laravel/artisan"), "<?php\n");
  await fs.writeFile(path.join(root, "laravel/composer.json"), '{"require":{"laravel/framework":"^13"}}');
  const blade = await open("laravel", "laravel/resources/views/welcome.blade.php", "<h1>Hello</h1>\n@if(true)\n<p>Welcome</p>\n@endif\n");
  assert(manager.status(blade.id).capabilities?.completionProvider);
  assert(manager.status(blade.id).projectRootUri.endsWith("/laravel"));
  pass("Pinned Laravel native LSP initialization and Blade activation");
  const bladeHover = await blade.request("textDocument/hover", { position: { line: 1, character: 2 } });
  console.log("Laravel Blade hover", JSON.stringify(bladeHover).slice(0, 300));
  await project.refresh();
  assert(project.info().frameworks.includes("laravel/framework"));
  assert((await project.relations("helper.ts")).importedBy.includes("README.mdx"));
  pass("Persisted project dependencies and MDX import mapping");
} finally {
  await manager.dispose(); await project.dispose();
  await fs.rm(root, { recursive: true, force: true }); await fs.rm(root + "-projects", { recursive: true, force: true });
  if (process.env.OXBIT_LSP_REPORT) await fs.writeFile(process.env.OXBIT_LSP_REPORT, JSON.stringify({ platform: `${process.platform}-${process.arch}`, reports }, null, 2) + "\n");
}
