import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceFiles } from "../../apps/runtime/src/filesystem.js";
import { LanguageServerManager } from "../../apps/runtime/src/lsp-manager.js";

const fixtures = [
  ["typescript", "main.ts", "export const hello: string = 'world';\n"],
  ["marksman", "README.md", "# Hello\n\n[Heading](#hello)\n"],
  ["mdx", "README.mdx", 'export const greeting = "hello"\n\n# Hello\n\n{greeting.toUpperCase()}\n'],
  ["laravel", "laravel/welcome.blade.php", "<h1>Hello</h1>\n"],
  ["html", "index.html", '<!doctype html><html><body><h1>Hello</h1></body></html>\n'],
  ["vue", "App.vue", '<script setup lang="ts">\nconst message: string = "hello";\n</script>\n<template><div>{{ message }}</div></template>\n'],
  ["astro", "index.astro", '---\nconst message: string = "hello";\n---\n<h1>{message}</h1>\n'],
  ["dockerfile", "Dockerfile", "FROM ubuntu:24.04\nRUN echo hello\n"],
  ["bash", "main.sh", '#!/usr/bin/env bash\nname="hello"\nprintf "%s\\n" "$name"\n'],
  ["json", "package.json", '{"name":"fixture","private":true}\n'],
  ["taplo", "Cargo.toml", '[package]\nname = "fixture"\nversion = "0.1.0"\n'],
  ["intelephense", "index.php", '<?php\nfunction greet(string $name): string { return "Hello " . $name; }\n'],
  ["lemminx", "index.xml", '<?xml version="1.0"?><root><hello>world</hello></root>\n'],
];
const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-managed-smoke-"));
const cache = process.env.OXBIT_LSP_CACHE ?? path.join(os.tmpdir(), "oxbit-managed-language-smoke-cache");
const records: unknown[] = [];
const manager = new LanguageServerManager(new WorkspaceFiles(root), cache, (method, params, instanceId) => {
  if (method === "window/logMessage") console.log(JSON.stringify({ instanceId, output: params.message }));
  if (method === "oxbit/serverState") console.log(JSON.stringify({ instanceId, ...params }));
});
try {
  await fs.mkdir(path.join(root, "laravel"));
  await fs.writeFile(path.join(root, "laravel/artisan"), "<?php\n");
  await fs.writeFile(path.join(root, ".marksman.toml"), "");
  for (const [id, file, text] of fixtures) {
    if (process.env.OXBIT_LSP_ONLY && !process.env.OXBIT_LSP_ONLY.split(",").includes(id)) continue;
    await fs.writeFile(path.join(root, file), text);
    manager.canonical(file, text);
    const attached = await manager.attach(file, "fixture", {}, {}, id);
    const result = await manager.start(false, attached.instanceId);
    const capabilities = result.capabilities;
    if (!capabilities || !Object.keys(capabilities).length) throw new Error(`${id}: empty capabilities`);
    if (capabilities.documentSymbolProvider) await manager.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(path.join(root, file)).href } }, undefined, undefined, attached.instanceId);
    records.push({ id, platform: `${process.platform}-${process.arch}`, version: manager.status(attached.instanceId).version, capabilities, initialized: true });
    console.log(`PASS ${id}`);
    await manager.stop(false, attached.instanceId);
  }
} finally {
  await manager.dispose();
  await fs.rm(root, { recursive: true, force: true });
  if (process.env.OXBIT_LSP_REPORT) await fs.writeFile(process.env.OXBIT_LSP_REPORT, JSON.stringify(records, null, 2) + "\n");
}
