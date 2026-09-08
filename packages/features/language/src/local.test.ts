import { logLocations } from "./log-links.js";
import { describe, expect, it } from "vitest";
import { parseCsv } from "@oxbit/sdk";
import { jsonlDiagnostics, localStructure, LocalLanguageTransport } from "./local.js";
describe("local language providers", () => {
  it("parses each nonblank JSONL record independently and maps CRLF offsets", async () => {
    expect(await jsonlDiagnostics("file:///data.jsonl", '{"x":1}\r\n\r\n{"x":2}\r\n')).toEqual([]);
    const diagnostics = await jsonlDiagnostics("file:///data.jsonl", '{"x":1}\r\n\r\n{"x": }\r\n');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every(item => item.range.start.line === 2)).toBe(true);
  });
  it("keeps CSV quoted newlines and escaped quotes in their fields", () => {
    const result = parseCsv('name,notes\r\n"Ryan","line 1\r\nline ""2"""\r\n');
    expect(result.errors).toEqual([]);
    expect(result.rows[1][1].value).toBe('line 1\r\nline "2"');
    expect(parseCsv('a,b\n1').errors[0].message).toContain("2 columns");
    expect(parseCsv('a\n"unterminated').errors[0].message).toContain("Unterminated");
  });
  it("provides INI sections/keys without inventing Bash diagnostics for Zsh or logs", () => {
    const ini = localStructure("ini", "[db]\nport=1\nport=2\nbroken\n");
    expect(ini.symbols[0].children?.map(item => item.name)).toEqual(["port", "port"]);
    expect(ini.diagnostics).toHaveLength(2);
    expect(localStructure("zsh", "setopt extendedglob\nfiles=(**/*.ts(N))\nfunction hello() {}\n").diagnostics).toEqual([]);
    expect(localStructure("log", "arbitrary application output").diagnostics).toEqual([]);
    expect(localStructure("dotenv", "KEY=$(rm -rf ignored)\n").symbols[0].name).toBe("KEY");
  });
  it("advertises only implemented methods and maps JSONL completion edits", async () => {
    const log = new LocalLanguageTransport("log");
    const capabilities = (await log.request<any>("initialize", {})).capabilities;
    expect(capabilities.completionProvider).toBeUndefined();
    expect(capabilities.documentSymbolProvider).toBeUndefined();
    const jsonl = new LocalLanguageTransport("jsonl");
    jsonl.notify("textDocument/didOpen", { textDocument: { uri: "file:///data.jsonl", languageId: "jsonl", version: 1, text: '{"x":1}\n{"flag": t}' } });
    const result = await jsonl.request<any>("textDocument/completion", { textDocument: { uri: "file:///data.jsonl" }, position: { line: 1, character: 10 } });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.filter((item: any) => item.textEdit).every((item: any) => item.textEdit.range.start.line === 1)).toBe(true);
    log.dispose(); jsonl.dispose();
  });
});

it("links only workspace-relative log locations", () => {
  expect(logLocations("Error in src/main.ts:12:3")).toMatchObject([{ path: "src/main.ts", line: 12, col: 3 }]);
  expect(logLocations("Error in ../../private/secret.ts:1")).toEqual([]);
  expect(logLocations("Error in /etc/secret.ts:1")).toEqual([]);
});

it("accepts multiline quoted environment values without evaluating interpolation", () => {
  expect(localStructure("dotenv", 'KEY="first\n${UNREAD}\nlast"\nNEXT=value').diagnostics).toEqual([]);
  expect(localStructure("dotenv", 'KEY="unterminated').diagnostics[0].message).toContain("Unterminated");
});
