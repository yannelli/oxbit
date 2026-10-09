import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import { PythonServer } from "./python.js";
import type { PythonHost } from "./python.js";

const require = createRequire(import.meta.url);
const resources: Record<string, string> = {
  "ruff_wasm_bg.wasm": join(dirname(require.resolve("@astral-sh/ruff-wasm-web")), "ruff_wasm_bg.wasm"),
  "pyright.worker.js": join(dirname(require.resolve("browser-basedpyright/package.json")), "dist/pyright.worker.js"),
};
let pyrightScript: vm.Script | undefined;
/** Mirrors the Swift `worker` host function with a Node realm per child context. */
const worker: PythonHost["worker"] = (source, name) => {
  const context = vm.createContext({
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask, TextEncoder, TextDecoder, performance,
    console: { log() {}, info() {}, warn() {}, debug() {}, trace() {}, error: console.error },
  });
  vm.runInContext(source, context);
  (pyrightScript ??= new vm.Script(readFileSync(resources[name], "utf8"), { filename: name })).runInContext(context);
  return context;
};

function setup(disk: Record<string, string> = {}, root = "/workspace", extra: Partial<PythonHost> = {}) {
  const files = new Map(Object.entries(disk).map(([path, text]) => [root + "/" + path, text]));
  const host: PythonHost = {
    readFile: path => files.get(path), fileExists: path => files.has(path),
    directoryExists: path => path === root || [...files.keys()].some(file => file.startsWith(path + "/")),
    list: path => JSON.stringify([...files.keys()].filter(file => file.startsWith(path + "/") && !file.slice(path.length + 1).includes("/")).map(file => ({ name: file.slice(path.length + 1), kind: "file" }))),
    resource: name => { const bytes = readFileSync(resources[name]); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    ...extra,
  };
  const server = createServer({ root, rootUri: "file://" + root, kind: "python" }, host, (files, host) => new PythonServer(files, host));
  const uri = (path: string) => "file://" + root + "/" + path;
  const open = async (path: string, text: string) => {
    const result = await server.dispatch("textDocument/didOpen", { textDocument: { uri: uri(path), text, version: 1, languageId: "python" } });
    expect(result.error).toBeUndefined();
    return (result.notifications.find(item => (item.params as any).uri === uri(path))!.params as any).diagnostics as any[];
  };
  return { server, uri, open };
}

describe("Python native language server (Ruff)", () => {
  it("reports unused imports and undefined names", async () => {
    const { server, open } = setup();
    expect((await server.dispatch("initialize", {})).error).toBeUndefined();
    const diagnostics = await open("main.py", "import os\nvalue = undefined_name\n");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "F401", source: "Ruff", severity: 2, tags: [1],
      range: { start: { line: 0, character: 7 }, end: { line: 0, character: 9 } },
      data: expect.objectContaining({ edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: "" }] }),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "F821", range: { start: { line: 1, character: 8 }, end: { line: 1, character: 22 } } }));
    expect(await open("broken.py", "def f(:\n")).toContainEqual(expect.objectContaining({ code: "invalid-syntax", severity: 1 }));
    await server.dispatch("exit", null);
  });

  it("formats the whole document", async () => {
    const { server, open, uri } = setup();
    await server.dispatch("initialize", {});
    await open("main.py", "x=1\nif x :\n  y=[1,2]\n");
    const formatted = await server.dispatch("textDocument/formatting", { textDocument: { uri: uri("main.py") }, options: { tabSize: 4, insertSpaces: true } });
    expect(formatted.result).toEqual([{ range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } }, newText: "x = 1\nif x:\n    y = [1, 2]\n" }]);
    await open("clean.py", "x = 1\n");
    expect((await server.dispatch("textDocument/formatting", { textDocument: { uri: uri("clean.py") }, options: {} })).result).toEqual([]);
  });

  it("reads line-length and lint selection from pyproject.toml", async () => {
    const { server, open, uri } = setup({ "pyproject.toml": '[project]\nname = "demo"\n\n[tool.ruff]\nline-length = 20\n\n[tool.ruff.lint]\nselect = [\n  "E501", # long lines\n]\n' });
    await server.dispatch("initialize", {});
    const diagnostics = await open("main.py", "import os\nvalue = call(first_argument, second)\n");
    expect(diagnostics.map(item => item.code)).toEqual(["E501"]);
    const formatted = await server.dispatch("textDocument/formatting", { textDocument: { uri: uri("main.py") }, options: {} });
    expect((formatted.result as any)[0].newText).toBe("import os\n\nvalue = call(\n    first_argument,\n    second,\n)\n");
  });
});

describe("Python native language server (basedpyright)", () => {
  const source = 'from helper import shout\n\n\nclass Greeter:\n    def __init__(self, name: str) -> None:\n        self.name = name\n\n    def greet(self) -> str:\n        return "Hello " + self.name\n\n\nGreeter("b").missing\nshout(Greeter("a").greet())\n';

  it("merges type diagnostics with Ruff and answers completion, hover, definition, and signature help", { timeout: 120_000 }, async () => {
    const { server, open, uri } = setup({ "helper.py": "def shout(text: str, times: int = 1) -> str:\n    return text.upper() * times\n" }, "/workspace", { worker });
    const initialized = await server.dispatch("initialize", {});
    expect((initialized.result as any).capabilities).toMatchObject({ hoverProvider: true, definitionProvider: true, documentFormattingProvider: true });
    const diagnostics = await open("main.py", source + "undefined_name\n");
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: "basedpyright", code: "reportAttributeAccessIssue", range: { start: { line: 11, character: 13 }, end: { line: 11, character: 20 } } }));
    expect(diagnostics.filter(item => /undefined_name/.test(item.message))).toEqual([expect.objectContaining({ source: "Ruff", code: "F821" })]);
    const overlaps = await open("overlaps.py", 'import os\n\ndef f():\n    unused = 1\n    print(later)\n    later = 2\n\ns = "\\d"\nassert (s, "m")\n__all__ = ["missing"]\nreturn 1\n');
    expect(overlaps.filter(item => item.source === "basedpyright")).toEqual([]);
    expect(overlaps.map(item => item.code)).toEqual(expect.arrayContaining(["F401", "F841", "F821", "W605", "F631", "F822", "F706"]));
    expect((await open("broken.py", "def f(:\n")).every(item => item.source === "Ruff" && item.code === "invalid-syntax")).toBe(true);
    expect(diagnostics.filter(item => item.source === "basedpyright").map(item => item.code)).not.toContain("reportUnannotatedClassAttribute");
    const at = (method: string, line: number, character: number) => server.dispatch(method, { textDocument: { uri: uri("main.py") }, position: { line, character } });
    const completion = await at("textDocument/completion", 8, 31);
    expect((completion.result as any).items.map((item: any) => item.label)).toEqual(expect.arrayContaining(["name", "greet"]));
    expect(((await at("textDocument/hover", 11, 2)).result as any).contents.value).toContain("class Greeter");
    expect((await at("textDocument/definition", 12, 2)).result).toEqual([expect.objectContaining({ uri: uri("helper.py"), range: expect.objectContaining({ start: { line: 0, character: 4 } }) })]);
    expect(((await at("textDocument/signatureHelp", 12, 6)).result as any).signatures[0].label).toContain("times: int");
    const changed = await server.dispatch("textDocument/didChange", { textDocument: { uri: uri("main.py"), version: 2 }, contentChanges: [{ text: source.replace(".missing", ".name") }] });
    expect((changed.notifications[0].params as any).diagnostics.filter((item: any) => item.source === "basedpyright")).toEqual([]);
    await server.dispatch("exit", null);
  });

  it("stays on Ruff when the host cannot start basedpyright", async () => {
    const { server, open, uri } = setup({}, "/workspace", { worker: () => null });
    await server.dispatch("initialize", {});
    expect(await open("main.py", "import os\n")).toEqual([expect.objectContaining({ code: "F401" })]);
    const hover = await server.dispatch("textDocument/hover", { textDocument: { uri: uri("main.py") }, position: { line: 0, character: 7 } });
    expect(hover.error?.message).toContain("basedpyright failed to start");
  });
});
