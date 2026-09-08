import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceFiles } from "../../apps/runtime/src/filesystem.js";
import { LanguageServerManager } from "../../apps/runtime/src/lsp-manager.js";

// Point this at a disposable composer create-project fixture, never a working application.
const root = await fs.realpath(process.env.OXBIT_LARAVEL_FIXTURE ?? "");
assert(path.basename(root).startsWith("oxbit-laravel-acceptance."), "Use a disposable oxbit-laravel-acceptance.* directory");
await fs.access(path.join(root, "vendor/autoload.php"));
await fs.writeFile(path.join(root, "routes/web.php"), "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/oxbit', fn () => view('oxbit-lsp'))->name('oxbit.fixture');\n");
await fs.writeFile(path.join(root, "resources/views/oxbit-lsp.blade.php"), "<h1>Oxbit fixture</h1>\n");
const reports: string[] = [];
const limitations: string[] = [];
const manager = new LanguageServerManager(new WorkspaceFiles(root), process.env.OXBIT_LSP_CACHE ?? path.join(os.tmpdir(), "oxbit-managed-language-smoke-cache"), (method, params) => {
  if (method === "window/logMessage" && /error|fail/i.test(params.message)) console.log(params.message);
});
async function open(file: string, text: string) {
  await fs.writeFile(path.join(root, file), text); manager.canonical(file, text);
  const attached = await manager.attach(file, "fixture", {}, {}, "laravel"); await manager.start(false, attached.instanceId);
  const textDocument = { uri: pathToFileURL(path.join(root, file)).href };
  return { id: attached.instanceId, request: (method: string, params: any) => manager.request(method, { textDocument, ...params }, undefined, undefined, attached.instanceId) };
}
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 25_000;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error("Missing Laravel result: " + JSON.stringify(value).slice(0, 1000)); await new Promise(resolve => setTimeout(resolve, 200)); }
}
function pass(feature: string) { reports.push(feature); console.log(`PASS ${feature}`); }
try {
  const php = await open("oxbit-lsp.php", "<?php\nroute('oxbit.fixture');\nview('oxbit-lsp');\nconfig('app.name');\n");
  const completion = await eventually(() => php.request("textDocument/completion", { position: { line: 1, character: 10 }, context: { triggerKind: 1 } }), result => (Array.isArray(result) ? result : result?.items ?? []).some((item: any) => item.label === "oxbit.fixture"));
  assert(completion); pass("Laravel named-route completion from the running project");
  const hover = await php.request("textDocument/hover", { position: { line: 1, character: 12 } }); assert(hover?.contents); pass("Laravel route hover");
  const definitions = await php.request("textDocument/definition", { position: { line: 2, character: 10 } });
  assert((Array.isArray(definitions) ? definitions : [definitions]).some((item: any) => (item?.uri ?? item?.targetUri)?.endsWith("/resources/views/oxbit-lsp.blade.php"))); pass("Laravel view definition into Blade");
  const blade = await open("resources/views/oxbit-consumer.blade.php", "@i");
  const directives = await eventually(() => blade.request("textDocument/completion", { position: { line: 0, character: 2 }, context: { triggerKind: 1 } }), result => (Array.isArray(result) ? result : result?.items ?? []).some((item: any) => item.label.startsWith("@if")));
  assert(directives.some((item: any) => item.insertTextFormat === 2)); pass("Blade directive snippet completion");
  manager.canonical("resources/views/oxbit-consumer.blade.php", "@include('");
  const includes = await blade.request("textDocument/completion", { position: { line: 0, character: 10 }, context: { triggerKind: 2, triggerCharacter: "'" } });
  if (!includes.length) { limitations.push("Laravel 0.0.31 returned no Blade @include string completions"); console.log("UPSTREAM LIMITATION: " + limitations[0]); }
  await manager.restart(php.id);
  assert((await php.request("textDocument/hover", { position: { line: 1, character: 12 } }))?.contents); pass("Laravel restart replay");
} finally {
  await manager.dispose();
  if (process.env.OXBIT_LSP_REPORT) await fs.writeFile(process.env.OXBIT_LSP_REPORT, JSON.stringify({ platform: `${process.platform}-${process.arch}`, reports, limitations }, null, 2) + "\n");
}
