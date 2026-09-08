import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SETTINGS_SCHEMA_URI, settingsSchema } from "../../packages/sdk/src/index.js";
import { WorkspaceFiles } from "../../apps/runtime/src/filesystem.js";
import { LanguageServerManager } from "../../apps/runtime/src/lsp-manager.js";
import { ProjectStore } from "../../apps/runtime/src/projects.js";
import { JsonSchemas } from "../../apps/runtime/src/json-schemas.js";

const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-settings-schema-"));
const files = new WorkspaceFiles(root);
const project = await new ProjectStore(files, root + "-projects").initialize();
const settings = project.info().configuration; settings.schemas = { catalog: false, download: false, associations: [] };
await fs.writeFile(path.join(project.directory, "project.json"), JSON.stringify(settings));
const diagnostics = new Map<string, any>();
const reports: string[] = [];
let downloads = 0;
const localSchema = path.join(root + "-projects", "schemas/settings.v1.schema.json");
await fs.mkdir(path.dirname(localSchema), { recursive: true });
await fs.writeFile(localSchema, JSON.stringify(settingsSchema));
const schemas = new JsonSchemas(files, path.join(root, "cache"), async () => { downloads++; throw new Error("Offline"); }, { schemaFile: localSchema, settingsPaths: [path.join(root, "custom/preferences.json")] });
const manager = new LanguageServerManager(files, process.env.OXBIT_LSP_CACHE ?? path.join(os.tmpdir(), "oxbit-managed-language-smoke-cache"), (method, params) => {
  if (method === "textDocument/publishDiagnostics") diagnostics.set(params.uri, params);
}, 300000, project, schemas);
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await read(); if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error("Unexpected LSP result: " + JSON.stringify(value).slice(0, 1000));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
function pass(feature: string) { reports.push(feature); console.log(`PASS ${feature}`); }
async function open(file: string, markedText: string) {
  const offset = markedText.indexOf("|"), text = markedText.replace("|", "");
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text); manager.canonical(file, text);
  const attached = await manager.attach(file, "schema-fixture", {}, {}, "json");
  await manager.start(false, attached.instanceId);
  const uri = pathToFileURL(path.join(root, file)).href;
  const position = { line: text.slice(0, offset).split("\n").length - 1, character: text.slice(0, offset).split("\n").at(-1)!.length };
  const request = (method: string, params: any) => manager.request(method, { textDocument: { uri }, ...params }, undefined, undefined, attached.instanceId);
  return { uri, request, completion: () => request("textDocument/completion", { position }) };
}
try {
  for (const file of [".oxbit/settings.json", ".oxbit/projects/86a6190e-6744-5df0-a25e-fd5a937090fa/settings.json", ".config/oxbit/settings.json", ".config/oxbit/settings.local.json", "custom/preferences.json"]) {
    const document = await open(file, '{\n  "|"\n}');
    await eventually(document.completion, result => result.items.some((item: any) => item.label === "editor.tabSize"));
    pass(`Automatic settings completion: ${file}`);
  }
  const nested = await open(".config/oxbit/settings.json", '{"[mdx]": {"editor.wordWrap": "|"}}');
  await eventually(nested.completion, result => result.items.some((item: any) => item.label.includes("bounded")));
  pass("Language override enum completion");
  const intelligence = await open(".config/oxbit/settings.local.json", '{"project.intelligence": {"|"}}');
  await eventually(intelligence.completion, result => result.items.some((item: any) => item.label === "maxFiles"));
  pass("Project intelligence property completion");
  const explicit = await open("explicit.json", '{"$schema": "' + SETTINGS_SCHEMA_URI + '", "|"}');
  await eventually(explicit.completion, result => result.items.some((item: any) => item.label === "languageServers"));
  pass("Explicit canonical schema URI works offline");
  const local = await open("local.json", '{"$schema": "' + pathToFileURL(localSchema).href + '", "|"}');
  await eventually(local.completion, result => result.items.some((item: any) => item.label === "project.schemas"));
  pass("Installed local schema outside workspace works offline");
  const invalid = await open(".config/oxbit/settings.local.json", '{"editor.tabSize": "large", "project.intelligence": {"maxFiles": 0}}|');
  await eventually(async () => diagnostics.get(invalid.uri), value => value?.diagnostics.some((item: any) => item.message.includes("number")) && value.diagnostics.some((item: any) => item.message.includes("1")));
  pass("Invalid type and numeric bound diagnostics");
  const hover = await invalid.request("textDocument/hover", { position: { line: 0, character: 5 } });
  assert(JSON.stringify(hover).includes("spaces")); pass("Setting descriptions in hover");
  assert.equal(downloads, 0); pass("Zero remote schema requests");
  await fs.mkdir("evidence/settings-files", { recursive: true });
  await fs.writeFile("evidence/settings-files/schema-lsp.json", JSON.stringify({ platform: `${process.platform}-${process.arch}`, reports, downloads }, null, 2) + "\n");
} finally {
  await manager.dispose(); await project.dispose();
  await fs.rm(root, { recursive: true, force: true }); await fs.rm(root + "-projects", { recursive: true, force: true });
}
