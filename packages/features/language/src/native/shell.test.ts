import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import { ShellServer } from "./shell.js";
import type { NativeFileHost } from "./files.js";

const require = createRequire(import.meta.url);
const resources: Record<string, string> = {
  "tree-sitter-bash.wasm": require.resolve("bash-language-server/tree-sitter-bash.wasm"),
  "web-tree-sitter.wasm": require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
  "shfmt.wasm": require.resolve("@wasm-fmt/shfmt/wasm"),
};

function setup(disk: Record<string, string> = {}) {
  const root = "/workspace", files = new Map(Object.entries(disk).map(([path, text]) => [root + "/" + path, text]));
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
    resource: name => {
      const bytes = readFileSync(resources[name]);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
  const server = createServer({ root, rootUri: "file://" + root, kind: "shell" }, host, (files, host) => ShellServer.create(files, host));
  const uri = (path: string) => "file://" + root + "/" + path;
  const open = (path: string, text: string, languageId = "shellscript") => server.dispatch("textDocument/didOpen", { textDocument: { uri: uri(path), text, version: 1, languageId } });
  const request = async (method: string, path: string, params: object = {}) => {
    const response = await server.dispatch(method, { textDocument: { uri: uri(path) }, ...params });
    expect(response.error).toBeUndefined();
    return response.result as any;
  };
  return { server, uri, open, request };
}

describe("device-local shell language server", () => {
  it("reports bash syntax errors and completes functions, builtins, and definitions", async () => {
    const { server, open, request, uri } = setup();
    expect((await server.dispatch("initialize", {})).error).toBeUndefined();
    const opened = await open("run.sh", "#!/bin/bash\n# Says hi\ngreet() { echo hi; }\nif then\ngre\nec\ngreet\n");
    expect(opened.error).toBeUndefined();
    expect((opened.notifications[0].params as any).diagnostics).toContainEqual(expect.objectContaining({ severity: 1, source: "bash" }));
    expect(await request("textDocument/completion", "run.sh", { position: { line: 4, character: 3 } })).toContainEqual(expect.objectContaining({ label: "greet" }));
    expect(await request("textDocument/completion", "run.sh", { position: { line: 5, character: 2 } })).toContainEqual(expect.objectContaining({ label: "echo" }));
    expect(await request("textDocument/definition", "run.sh", { position: { line: 6, character: 1 } })).toEqual([{ uri: uri("run.sh"), range: expect.objectContaining({ start: { line: 2, character: 0 } }) }]);
    const hover = await request("textDocument/hover", "run.sh", { position: { line: 6, character: 2 } });
    expect(hover.contents.value).toContain("Function: **greet** - *defined on line 3*");
    expect(hover.contents.value).toContain("Says hi");
    const references = await request("textDocument/references", "run.sh", { position: { line: 6, character: 1 }, context: { includeDeclaration: true } });
    expect(references.length).toBeGreaterThan(1);
    expect(await request("textDocument/documentSymbol", "run.sh")).toContainEqual(expect.objectContaining({ name: "greet" }));
    await server.dispatch("exit", null);
  });

  it("formats with shfmt and leaves documents with syntax errors unchanged", async () => {
    const { server, open, request } = setup();
    await server.dispatch("initialize", {});
    await open("format.sh", "if true; then\necho hi\nfi\n");
    const [edit] = await request("textDocument/formatting", "format.sh", { options: { tabSize: 4, insertSpaces: true } });
    expect(edit).toEqual({ range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } }, newText: "if true; then\n    echo hi\nfi\n" });
    await open("broken.sh", "if then\n");
    expect(await request("textDocument/formatting", "broken.sh", { options: { tabSize: 2, insertSpaces: true } })).toBeNull();
    await server.dispatch("exit", null);
  });

  it("opens zsh documents, completes their functions, and formats zsh syntax", async () => {
    const { server, open, request } = setup();
    await server.dispatch("initialize", {});
    const opened = await open(".zshrc", "setopt autocd\nalias ll='ls -l'\nfunction greet { echo hi; }\nfi\ngre", "zsh");
    expect(opened.error).toBeUndefined();
    expect(await request("textDocument/completion", ".zshrc", { position: { line: 4, character: 3 } })).toContainEqual(expect.objectContaining({ label: "greet" }));
    await open("end.sh", "greet() { echo hi; }\nif then\ngre");
    expect(await request("textDocument/completion", "end.sh", { position: { line: 2, character: 3 } })).toContainEqual(expect.objectContaining({ label: "greet" }));
    const zsh = await open("lines.zsh", "for line in ${(f)text}; do\nprint -r -- $line\ndone\n", "zsh");
    expect(zsh.notifications.filter((item: any) => item.params.uri.endsWith("/lines.zsh")).flatMap((item: any) => item.params.diagnostics)).toEqual([]);
    const [edit] = await request("textDocument/formatting", "lines.zsh", { options: { tabSize: 2, insertSpaces: true } });
    expect(edit.newText).toBe("for line in ${(f)text}; do\n  print -r -- $line\ndone\n");
    await server.dispatch("exit", null);
  });

  it("reports unterminated zsh constructs and accepts zsh short forms", async () => {
    const { server, open } = setup();
    await server.dispatch("initialize", {});
    const diagnostics = async (path: string, text: string) => (await open(path, text, "zsh")).notifications.filter((item: any) => item.params.uri.endsWith("/" + path)).flatMap((item: any) => item.params.diagnostics);
    expect(await diagnostics("short.zsh", "for x (a b) { echo $x }\nif [[ -n $x ]] { echo ok }\n{ echo hi } always { echo done }\nfoo() { print ${(j:,:)@} }\n")).toEqual([]);
    expect(await diagnostics("open.zsh", "# 😀\nif true; then\n  echo hi\n")).toEqual([
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, severity: 1, source: "zsh", message: "Syntax error: `if` statement must end with `fi`" },
    ]);
    expect(await diagnostics("quote.zsh", 'echo 😀 "hello\n')).toEqual([
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 14 } }, severity: 1, source: "zsh", message: "Syntax error: reached EOF without closing quote `\"`" },
    ]);
    await server.dispatch("exit", null);
  });
});
