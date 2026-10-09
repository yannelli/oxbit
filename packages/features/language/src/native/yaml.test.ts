import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import { YamlServer } from "./yaml.js";
import type { NativeFileHost } from "./files.js";

const schemaDirectory = new URL("../../schemas/", import.meta.url);
const bundled: Record<string, { file: string }> = JSON.parse(readFileSync(new URL("index.json", schemaDirectory), "utf8")).schemas;

function setup(disk: Record<string, string> = {}) {
  const root = "/workspace";
  const files = new Map(Object.entries(disk).map(([path, text]) => [root + "/" + path, text]));
  const requests: [string, boolean][] = [];
  const host: NativeFileHost = {
    readFile: path => files.get(path), fileExists: path => files.has(path),
    directoryExists: path => path === root, list: () => "[]",
    schema: (uri, download, completion) => {
      requests.push([uri, download]);
      const entry = bundled[uri];
      if (entry) completion(readFileSync(new URL(entry.file, schemaDirectory), "utf8"), null);
      else completion(null, "missing");
    },
  };
  const server = createServer({ root, rootUri: "file://" + root, kind: "yaml" }, host, async (files, host, settings) => {
    const service = new YamlServer(files, host);
    await service.changed(settings ?? {});
    return service;
  });
  const uri = (path: string) => `file://${root}/${path}`;
  const open = (path: string, text: string) => server.dispatch("textDocument/didOpen", { textDocument: { uri: uri(path), text, version: 1, languageId: "yaml" } });
  const diagnostics = (result: Awaited<ReturnType<typeof open>>, path: string) => (result.notifications.find(item => (item.params as any).uri === uri(path))!.params as any).diagnostics as any[];
  return { server, uri, open, diagnostics, requests };
}

const workflow = "on: push\njobs:\n  build:\n    runs-on: 5\n";

describe("YAML native language server", () => {
  it("validates GitHub workflows against the cached catalog schema and completes schema keys", async () => {
    const { server, open, uri, diagnostics, requests } = setup();
    expect((await server.dispatch("initialize", { initializationOptions: { settings: { schemaDownload: false } } })).error).toBeUndefined();
    const opened = await open(".github/workflows/ci.yml", workflow + "    \n");
    expect(diagnostics(opened, ".github/workflows/ci.yml")).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("Incorrect type"), source: expect.stringContaining("github-workflow.json"),
      range: { start: { line: 3, character: 13 }, end: { line: 3, character: 14 } },
    }));
    expect(requests.every(([, download]) => download === false)).toBe(true);
    const completion = await server.dispatch("textDocument/completion", { textDocument: { uri: uri(".github/workflows/ci.yml") }, position: { line: 4, character: 4 } });
    expect((completion.result as any).items).toContainEqual(expect.objectContaining({ label: "steps" }));
    const hover = await server.dispatch("textDocument/hover", { textDocument: { uri: uri(".github/workflows/ci.yml") }, position: { line: 1, character: 1 } });
    expect((hover.result as any).contents.value).toContain("jobs");
    const symbols = await server.dispatch("textDocument/documentSymbol", { textDocument: { uri: uri(".github/workflows/ci.yml") } });
    expect(symbols.result).toContainEqual(expect.objectContaining({ name: "jobs" }));
    await server.dispatch("exit", null);
  });

  it("reports syntax errors and formats documents", async () => {
    const { server, open, uri, diagnostics } = setup();
    await server.dispatch("initialize", {});
    const broken = await open("broken.yaml", "key: [unclosed\nother: 1\n");
    expect(diagnostics(broken, "broken.yaml")).toContainEqual(expect.objectContaining({ severity: 1, source: "YAML" }));
    await open("plain.yaml", "list:   [a,   b]\nkey:     value\n");
    const formatted = await server.dispatch("textDocument/formatting", { textDocument: { uri: uri("plain.yaml") }, options: { tabSize: 2, insertSpaces: true } });
    expect(formatted.result).toEqual([expect.objectContaining({ newText: "list: [a, b]\nkey: value\n" })]);
    await server.dispatch("exit", null);
  });

  it("honors a schema modeline pointing at a workspace schema", async () => {
    const { server, open, diagnostics } = setup({ "schema.json": '{"type":"object","properties":{"port":{"type":"number"}}}' });
    await server.dispatch("initialize", {});
    const opened = await open("config.yaml", "# yaml-language-server: $schema=./schema.json\nport: wrong\n");
    expect(diagnostics(opened, "config.yaml")).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/number/) }));
    await server.dispatch("exit", null);
  });

  it("drops catalog associations when schemaStore is off", async () => {
    const { server, open, diagnostics } = setup();
    await server.dispatch("initialize", { initializationOptions: { settings: { schemaDownload: false } } });
    expect(diagnostics(await open(".github/workflows/ci.yml", workflow), ".github/workflows/ci.yml")).not.toEqual([]);
    const changed = await server.dispatch("workspace/didChangeConfiguration", { settings: { schemaStore: false } });
    expect(diagnostics(changed, ".github/workflows/ci.yml")).toEqual([]);
    await server.dispatch("exit", null);
  });
});
