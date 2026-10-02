import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import type { NativeFileHost, ServerOptions } from "./files.js";

const libDirectory = dirname(createRequire(import.meta.url).resolve("typescript"));
const libraries = Object.fromEntries(readdirSync(libDirectory).filter(file => /^lib\..*\.d\.ts$/.test(file)).map(file => ["/__oxbit_typescript__/" + file, readFileSync(join(libDirectory, file), "utf8")]));

function setup(kind: ServerOptions["kind"], disk: Record<string, string> = {}, root = "/workspace") {
  const files = new Map(Object.entries(disk).map(([path, text]) => [root + "/" + path, text]));
  const host: NativeFileHost = {
    readFile: path => files.get(path), fileExists: path => files.has(path),
    directoryExists: path => path === root || [...files.keys()].some(file => file.startsWith(path + "/")),
    list: path => {
      const entries = new Map<string, { name: string; kind: "file" | "directory" }>();
      for (const file of files.keys()) if (file.startsWith(path + "/")) {
        const parts = file.slice(path.length + 1).split("/");
        entries.set(parts[0], { name: parts[0], kind: parts.length > 1 ? "directory" : "file" });
      }
      return JSON.stringify([...entries.values()]);
    },
  };
  const server = createServer({ root, rootUri: "file://" + root, kind }, host, libraries);
  const uri = (path: string) => "file://" + root.split("/").map(encodeURIComponent).join("/") + "/" + path.split("/").map(encodeURIComponent).join("/");
  const open = (path: string, text: string, languageId = kind === "typescript" ? "typescript" : "json", version = 1) => server.dispatch("textDocument/didOpen", { textDocument: { uri: uri(path), text, version, languageId } });
  return { server, uri, open, files };
}

describe("device-local native language servers", () => {
  it("uses bundled TypeScript libraries for diagnostics, hover, and member completion", async () => {
    const { server, open, uri } = setup("typescript");
    expect((await server.dispatch("initialize", {})).error).toBeUndefined();
    const opened = await open("main.ts", 'const words = ["hello"];\nconst value: number = "wrong";\nwords.ma');
    expect(opened.error).toBeUndefined();
    expect((opened.notifications[0].params as any).diagnostics).toContainEqual(expect.objectContaining({ code: 2322 }));
    const completion = await server.dispatch("textDocument/completion", { textDocument: { uri: uri("main.ts") }, position: { line: 2, character: 8 } });
    expect(completion.error).toBeUndefined();
    expect((completion.result as any).items).toContainEqual(expect.objectContaining({ label: "map" }));
    const hover = await server.dispatch("textDocument/hover", { textDocument: { uri: uri("main.ts") }, position: { line: 0, character: 8 } });
    expect((hover.result as any).contents.value).toContain("string[]");
    await server.dispatch("exit", null);
  });

  it("resolves disk imports and includes unsaved documents in cross-file rename", async () => {
    const { server, open, uri } = setup("typescript", { "dependency.ts": "export const message = 123;" });
    await server.dispatch("initialize", {});
    await open("dependency.ts", 'export const message = "unsaved";');
    const main = 'import { message } from "./dependency";\nmessage;';
    const opened = await open("main.ts", main);
    expect(opened.error).toBeUndefined();
    const definition = await server.dispatch("textDocument/definition", { textDocument: { uri: uri("main.ts") }, position: { line: 1, character: 3 } });
    expect(definition.result).toContainEqual(expect.objectContaining({ uri: uri("dependency.ts") }));
    const hover = await server.dispatch("textDocument/hover", { textDocument: { uri: uri("main.ts") }, position: { line: 1, character: 3 } });
    expect((hover.result as any).contents.value).toContain('"unsaved"');
    const renamed = await server.dispatch("textDocument/rename", { textDocument: { uri: uri("dependency.ts") }, position: { line: 0, character: 15 }, newName: "greeting" });
    expect(renamed.error).toBeUndefined();
    expect(Object.keys((renamed.result as any).changes).sort()).toEqual([uri("dependency.ts"), uri("main.ts")].sort());
    const references = await server.dispatch("textDocument/references", { textDocument: { uri: uri("main.ts") }, position: { line: 1, character: 3 }, context: { includeDeclaration: true } });
    expect((references.result as any[]).length).toBeGreaterThan(1);
    await server.dispatch("exit", null);
  });

  it("honors project settings, refreshes changed imports, and ignores stale document versions", async () => {
    const { server, open, uri, files } = setup("typescript", {
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["src"]}',
      "src/dependency.ts": "export const value = 123;",
    });
    await server.dispatch("initialize", {});
    const opened = await open("src/main.ts", 'import { value } from "./dependency";\nconst result: number = value;\nfunction missing(arg) {}');
    expect((opened.notifications[0].params as any).diagnostics).toContainEqual(expect.objectContaining({ code: 7006 }));
    files.set("/workspace/src/dependency.ts", 'export const value = "changed";');
    const changed = await server.dispatch("workspace/didChangeWatchedFiles", { changes: [{ uri: uri("src/dependency.ts"), type: 2 }] });
    expect((changed.notifications[0].params as any).diagnostics).toContainEqual(expect.objectContaining({ code: 2322 }));
    await server.dispatch("textDocument/didChange", { textDocument: { uri: uri("src/main.ts"), version: 2 }, contentChanges: [{ text: "const fresh = 1;" }] });
    const stale = await server.dispatch("textDocument/didChange", { textDocument: { uri: uri("src/main.ts"), version: 1 }, contentChanges: [{ text: "broken text" }] });
    expect(stale.notifications).toEqual([]);
    const symbols = await server.dispatch("textDocument/documentSymbol", { textDocument: { uri: uri("src/main.ts") } });
    expect(symbols.result).toContainEqual(expect.objectContaining({ name: "fresh" }));
    await server.dispatch("exit", null);
  });

  it("supports JavaScript and TSX documents with UTF-16 positions", async () => {
    const { server, open, uri } = setup("typescript");
    await server.dispatch("initialize", {});
    expect((await open("main.jsx", 'const face = "😀";\nfunction greet(value) { return value; }', "javascriptreact")).error).toBeUndefined();
    const symbols = await server.dispatch("textDocument/documentSymbol", { textDocument: { uri: uri("main.jsx") } });
    expect(symbols.result).toContainEqual(expect.objectContaining({ name: "greet", kind: 12 }));
    expect((await open("view.tsx", "const View = () => <div />;", "typescriptreact")).error).toBeUndefined();
    await server.dispatch("exit", null);
  });

  it("validates JSON, accepts JSONC comments, and resolves workspace schemas", async () => {
    const { server, open, uri } = setup("json", { "schema.json": '{"type":"object","properties":{"count":{"type":"number","description":"Item count"}}}' });
    await server.dispatch("initialize", {});
    const invalid = await open("data.json", '{"$schema":"./schema.json","count":"wrong"}');
    expect(invalid.error).toBeUndefined();
    expect((invalid.notifications[0].params as any).diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/number/) }));
    const jsonc = await open("config.jsonc", '{\n// comment\n"enabled": true,\n}', "jsonc");
    expect((jsonc.notifications.find(item => (item.params as any).uri === uri("config.jsonc"))!.params as any).diagnostics).toEqual([]);
    const hover = await server.dispatch("textDocument/hover", { textDocument: { uri: uri("data.json") }, position: { line: 0, character: 29 } });
    expect(JSON.stringify(hover.result)).toContain("Item count");
    await server.dispatch("exit", null);
  });

  it("rejects outside URIs and requests after shutdown, and clears closed diagnostics", async () => {
    const { server, open, uri } = setup("json", {}, "/workspace folder");
    expect((await server.dispatch("textDocument/hover", {})).error?.message).toContain("not initialized");
    await server.dispatch("initialize", {});
    const outside = await server.dispatch("textDocument/didOpen", { textDocument: { uri: "file:///outside/secret.json", languageId: "json", text: "{}", version: 1 } });
    expect(outside.error?.message).toContain("outside");
    await open("data.json", "{");
    const closed = await server.dispatch("textDocument/didClose", { textDocument: { uri: uri("data.json") } });
    expect(closed.notifications).toContainEqual({ method: "textDocument/publishDiagnostics", params: { uri: uri("data.json"), diagnostics: [] } });
    await server.dispatch("shutdown", null);
    expect((await server.dispatch("initialize", {})).error?.message).toContain("shut down");
    await server.dispatch("exit", null);
  });

  it("serializes the native completion callback as JSON without exposing thrown errors", async () => {
    const { server } = setup("json");
    const response = await new Promise<string>(resolve => server.handle("initialize", "{}", resolve));
    expect(JSON.parse(response).result.capabilities.hoverProvider).toBe(true);
    const invalid = await new Promise<string>(resolve => server.handle("textDocument/hover", "invalid json", resolve));
    expect(JSON.parse(invalid).error.message).toContain("SyntaxError");
    await server.dispatch("exit", null);
  });
});
