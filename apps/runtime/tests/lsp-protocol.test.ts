import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { LanguageServer } from "../src/lsp.js";
import { WorkspaceFiles } from "../src/filesystem.js";
import { incrementalChange, textOffset, effectiveCapabilities } from "@oxbit/sdk";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(sync: unknown) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-protocol-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const source = `const {createMessageConnection,StreamMessageReader,StreamMessageWriter}=require(${JSON.stringify(createRequire(import.meta.url).resolve("vscode-jsonrpc/node.js"))});
const connection=createMessageConnection(new StreamMessageReader(process.stdin),new StreamMessageWriter(process.stdout));
const events=[];connection.onNotification((method,params)=>events.push({method,params}));
connection.onRequest('initialize',()=>({capabilities:{textDocumentSync:${JSON.stringify(sync)},hoverProvider:true,codeActionProvider:true}}));
connection.onRequest((_method,params)=>params);
connection.onRequest('fixture/events',()=>events);
connection.onRequest('fixture/register',async params=>{try{await connection.sendRequest('client/registerCapability',params);return true}catch{return false}});
connection.onRequest('fixture/unregister',params=>connection.sendRequest('client/unregisterCapability',params));
connection.onRequest('fixture/configuration',params=>connection.sendRequest('workspace/configuration',params));
connection.onRequest('fixture/slow',(_params,token)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve('obsolete'),1000);token.onCancellationRequested(()=>{clearTimeout(timer);events.push({method:'cancelled'});resolve(null)})}));
connection.onRequest('shutdown',()=>null);connection.onNotification('exit',()=>process.exit(0));connection.listen();`;
  await fs.writeFile(path.join(root, "fixture.cjs"), source);
  const server = new LanguageServer(new WorkspaceFiles(root), () => {}, { prepare: async () => ({ executable: process.execPath, args: [path.join(root, "fixture.cjs")], settings: { example: { answer: 42 } } }) });
  cleanup.push(() => server.stop());
  server.canonical("main.ts", "const emoji = '😀';\r\nvalue\r\n", "typescript");
  await server.start();
  return server;
}
describe("negotiated language protocol", () => {
  it("round-trips opaque embedded-language data for resolution, diagnostics and hierarchy requests", async () => {
    const server = await fixture(2);
    const uri = server.uri("index.astro"), range = { start: { line: 1, character: 6 }, end: { line: 1, character: 13 } };
    const data = { uri, original: { data: { uri: "volar-embedded-content://tsx/astro-document" } }, embeddedDocumentUri: "volar-embedded-content://tsx/astro-document" };
    const diagnostic = { range, message: "Unknown name", data };
    for (const method of ["completionItem/resolve", "codeAction/resolve", "inlayHint/resolve", "documentLink/resolve", "workspaceSymbol/resolve"]) {
      const item = { label: "message", data, diagnostics: method === "codeAction/resolve" ? [diagnostic] : undefined };
      const expected = JSON.parse(JSON.stringify(item));
      expect(await server.request(method, item)).toEqual(expected);
    }
    const action = { textDocument: { uri }, range, context: { diagnostics: [diagnostic] } };
    expect(await server.request("textDocument/codeAction", action)).toEqual(action);
    for (const method of ["callHierarchy/incomingCalls", "callHierarchy/outgoingCalls", "typeHierarchy/supertypes", "typeHierarchy/subtypes"]) {
      const params = { item: { name: "message", kind: 12, uri, range, selectionRange: range, data } };
      expect(await server.request(method, params)).toEqual(params);
    }
  });
  it("still validates protocol document, location and edit URIs outside opaque data", async () => {
    const server = await fixture(2), uri = "volar-embedded-content://tsx/astro-document";
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    for (const [method, params] of [
      ["textDocument/hover", { textDocument: { uri }, position: range.start }],
      ["codeAction/resolve", { data: { uri }, edit: { documentChanges: [{ textDocument: { uri }, edits: [] }] } }],
      ["textDocument/codeAction", { textDocument: { uri: server.uri("main.ts") }, range, context: { diagnostics: [{ range, message: "test", data: { uri }, relatedInformation: [{ location: { uri, range }, message: "test" }] }] } }],
      ["inlayHint/resolve", { data: { uri }, label: [{ value: "type", location: { uri, range } }] }],
      ["callHierarchy/incomingCalls", { item: { uri, data: { uri } } }],
      ["workspace/executeCommand", { command: "example", arguments: [{ data: { uri } }] }],
    ] as const) await expect(server.request(method, params)).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(server.request("codeAction/resolve", { data: { uri }, edit: { documentChanges: [{ kind: "rename", oldUri: server.uri("main.ts"), newUri: server.uri("../outside.ts") }] } })).rejects.toMatchObject({ code: "PATH_DENIED" });
  });
  it.each([0, 1, 2])("honors sync kind %s, save text, ordered changes and restart replay", async kind => {
    const server = await fixture({ openClose: true, change: kind, save: { includeText: true } });
    server.canonical("main.ts", "const emoji = '😎';\r\nvalue\r\n", "typescript");
    server.saved("main.ts", "wrong text");
    server.saved("main.ts", "const emoji = '😎';\r\nvalue\r\n");
    const events: any[] = await server.request("fixture/events", {});
    const open = events.find(event => event.method === "textDocument/didOpen");
    expect(events.filter(event => event.method === "textDocument/didOpen")).toHaveLength(1);
    const changes = events.filter(event => event.method === "textDocument/didChange");
    expect(changes).toHaveLength(kind ? 1 : 0);
    if (kind) {
      const change = changes[0].params.contentChanges[0];
      expect(Boolean(change.range)).toBe(kind === 2);
      if (change.range) expect(open.params.textDocument.text.slice(0, textOffset(open.params.textDocument.text, change.range.start)) + change.text + open.params.textDocument.text.slice(textOffset(open.params.textDocument.text, change.range.end))).toContain("😎");
    }
    expect(events.filter(event => event.method === "textDocument/didSave")).toHaveLength(1);
    await server.restart();
    const replay: any[] = await server.request("fixture/events", {});
    expect(replay.find(event => event.method === "textDocument/didOpen").params.textDocument).toMatchObject({ version: 2, text: "const emoji = '😎';\r\nvalue\r\n" });
  });
  it("omits document lifecycle without openClose and omits save without save support", async () => {
    const server = await fixture({ openClose: false, change: 0 });
    server.saved("main.ts", "const emoji = '😀';\r\nvalue\r\n"); server.closeCanonical("main.ts");
    expect((await server.request<any[]>("fixture/events", {})).filter(event => event.method.startsWith("textDocument/"))).toEqual([]);
  });
  it("registers and unregisters selectors atomically and rejects unsupported registrations", async () => {
    const server = await fixture(1);
    expect(await server.request("fixture/register", { registrations: [{ id: "hover", method: "textDocument/completion", registerOptions: { documentSelector: [{ language: "php" }], triggerCharacters: ["$"] } }] })).toBe(true);
    const status = server.status();
    expect(effectiveCapabilities(status.capabilities!, status.registrations, { path: "main.ts", language: "typescript" }).completionProvider).toBeUndefined();
    expect(effectiveCapabilities(status.capabilities!, status.registrations, { path: "main.php", language: "php" }).completionProvider.triggerCharacters).toEqual(["$"]);
    expect(await server.request("fixture/register", { registrations: [{ id: "bad", method: "textDocument/codeLens" }] })).toBe(false);
    await server.request("fixture/unregister", { unregisterations: [{ id: "hover", method: "textDocument/completion" }] });
    expect(server.status().registrations).toEqual([]);
    expect(await server.request("fixture/configuration", { items: [{ section: "example.answer" }, { section: "missing" }] })).toEqual([42, null]);
  });
  it("replays documents when synchronization is dynamically registered", async () => {
    const server = await fixture({ openClose: false, change: 0 });
    expect(await server.request("fixture/register", { registrations: [{ id: "open", method: "textDocument/didOpen", registerOptions: { documentSelector: [{ language: "typescript" }] } }, { id: "change", method: "textDocument/didChange", registerOptions: { syncKind: 2 } }] })).toBe(true);
    server.canonical("main.ts", "changed", "typescript");
    const events = await server.request<any[]>("fixture/events", {});
    expect(events.filter(event => event.method === "textDocument/didOpen")).toHaveLength(1);
    expect(events.find(event => event.method === "textDocument/didChange").params.contentChanges[0].range).toBeDefined();
    await server.request("fixture/unregister", { unregisterations: [{ id: "open", method: "textDocument/didOpen" }] });
    expect((await server.request<any[]>("fixture/events", {})).filter(event => event.method === "textDocument/didClose")).toHaveLength(1);
  });
  it("filters registered watchers and removes them on unregister", async () => {
    const server = await fixture(1);
    await server.request("fixture/register", { registrations: [{ id: "watch", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [{ globPattern: "**/*.json", kind: 2 }] } }] });
    await server.watched("config.json", 1); await server.watched("config.json", 2); await server.watched("main.ts", 2);
    await expect(server.watched("../escape.json", 2)).rejects.toThrow();
    await server.request("fixture/unregister", { unregisterations: [{ id: "watch", method: "workspace/didChangeWatchedFiles" }] });
    await server.watched("config.json", 2);
    expect((await server.request<any[]>("fixture/events", {})).filter(event => event.method === "workspace/didChangeWatchedFiles")).toHaveLength(1);
  });
  it("sends JSON-RPC cancellation and rejects obsolete requests", async () => {
    const server = await fixture(1), controller = new AbortController();
    const pending = server.request("fixture/slow", {}, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await server.request<any[]>("fixture/events", {})).some(event => event.method === "cancelled")).toBe(true);
  });
  it.each([["a\r\nb", "a\nb"], ["😀x", "😎y"], ["one\ntwo", "one\nnew\ntwo"], ["", "😀\r\n"], ["😀", ""]])("round-trips Unicode and line endings %j", (before, after) => {
    const change = incrementalChange(before, after);
    expect(before.slice(0, textOffset(before, change.range.start)) + change.text + before.slice(textOffset(before, change.range.end))).toBe(after);
  });
});
