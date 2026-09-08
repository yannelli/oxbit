import { parseCsv, textPosition, textOffset, type LanguageTransport } from "@oxbit/sdk";
import { getLanguageService } from "vscode-json-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";

const json = getLanguageService({});
const builtins = ["autoload", "bindkey", "builtin", "cd", "command", "compdef", "compinit", "declare", "dirs", "disown", "echo", "emulate", "eval", "exec", "export", "functions", "getopts", "hash", "history", "jobs", "kill", "local", "popd", "print", "printf", "pushd", "pwd", "read", "readonly", "rehash", "set", "setopt", "source", "test", "trap", "typeset", "ulimit", "umask", "unalias", "unfunction", "unset", "unsetopt", "wait", "whence", "which", "zmodload", "zstyle"];
type Range = { start: { line: number; character: number }; end: { line: number; character: number } };
type Symbol = { name: string; kind: number; range: Range; selectionRange: Range; children?: Symbol[] };
export function localStructure(language: string, text: string) {
  const symbols: Symbol[] = [], diagnostics: { range: Range; severity: number; message: string; source: string }[] = [];
  const seen = new Set<string>();
  let section: Symbol | undefined;
  let environmentQuote: { quote: string; line: number; symbol: Symbol } | undefined;
  const closingQuote = (value: string, quote: string) => {
    for (let at = 0; at < value.length; at++) {
      if (quote === '"' && value[at] === "\\") { at++; continue; }
      if (value[at] === quote) return true;
    }
    return false;
  };
  const issue = (line: number, length: number, message: string) => diagnostics.push({ range: { start: { line, character: 0 }, end: { line, character: length } }, severity: 1, message, source: "Oxbit" });
  text.split(/\r?\n/).forEach((line, index) => {
    if (environmentQuote) {
      environmentQuote.symbol.range = { start: environmentQuote.symbol.range.start, end: { line: index, character: line.length } };
      if (closingQuote(line, environmentQuote.quote)) environmentQuote = undefined;
      return;
    }
    if (!line.trim() || /^\s*[#;]/.test(line)) return;
    const range = { start: { line: index, character: 0 }, end: { line: index, character: line.length } };
    if (language === "ini" && /^\s*\[/.test(line)) {
      const match = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(line);
      if (!match) { issue(index, line.length, "Expected [section]"); return; }
      section = { name: match[1], kind: 3, range, selectionRange: range, children: [] };
      symbols.push(section); return;
    }
    if (language === "ini" || language === "dotenv") {
      const match = (language === "ini" ? /^\s*([^=:#\s][^=:]*?)\s*[=:](.*)$/ : /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/).exec(line);
      if (!match) { issue(index, line.length, "Expected a key assignment"); return; }
      const name = match[1].trim(), key = (section?.name ?? "") + "\0" + name;
      if (seen.has(key)) diagnostics.push({ range, severity: 2, message: `Duplicate key: ${name}`, source: "Oxbit" });
      seen.add(key);
      const symbol = { name, kind: 13, range, selectionRange: range };
      if (section) { section.children!.push(symbol); section.range = { start: section.range.start, end: range.end }; }
      else symbols.push(symbol);
      const value = match[2].trimStart();
      if (language === "dotenv" && ["'", '"'].includes(value[0]) && !closingQuote(value.slice(1), value[0])) environmentQuote = { quote: value[0], line: index, symbol };
    }
    if (language === "zsh") {
      const match = /^\s*(?:function\s+([\w:-]+)|([\w:-]+)\s*\(\s*\))/.exec(line);
      const variable = /^\s*(?:(?:export|local|typeset|readonly)\s+(?:-[\w]+\s+)*)?([A-Za-z_]\w*)=/.exec(line);
      if (match || variable) symbols.push({ name: match?.[1] ?? match?.[2] ?? variable![1], kind: match ? 12 : 13, range, selectionRange: range });
    }
  });
  if (environmentQuote) issue(environmentQuote.line, text.split(/\r?\n/)[environmentQuote.line].length, "Unterminated quoted environment value");
  if (language === "csv") {
    const parsed = parseCsv(text);
    for (const field of parsed.rows[0] ?? []) {
      const range = { start: textPosition(text, field.from), end: textPosition(text, field.to) };
      symbols.push({ name: field.value || `Column ${field.column + 1}`, kind: 7, range, selectionRange: range });
    }
    for (const error of parsed.errors) diagnostics.push({ range: { start: textPosition(text, error.from), end: textPosition(text, error.to) }, message: error.message, severity: 1, source: "Oxbit CSV" });
  }
  return { symbols, diagnostics };
}

/** Each JSONL record gets its own JSON document and parser. Blank records are ignored. */
export async function jsonlDiagnostics(uri: string, text: string, version = 1) {
  const diagnostics: any[] = [];
  for (const [line, record] of text.split(/\r?\n/).entries()) {
    if (!record.trim()) continue;
    const document = TextDocument.create(`${uri}#record-${line}`, "json", version, record);
    const result = await json.doValidation(document, json.parseJSONDocument(document), { comments: "error", trailingCommas: "error" });
    for (const item of result) diagnostics.push({ ...item, source: "Oxbit JSONL", range: { start: { ...item.range.start, line }, end: { ...item.range.end, line } } });
  }
  return diagnostics;
}

export class LocalLanguageTransport implements LanguageTransport {
  private documents = new Map<string, { text: string; language: string; version: number }>();
  private listeners = new Set<(method: string, params: any) => void>();
  constructor(private language: string) {}
  async request<T>(method: string, params: any, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (method === "initialize") return { capabilities: {
      positionEncoding: "utf-16", textDocumentSync: 1,
      ...(["ini", "dotenv", "zsh", "csv"].includes(this.language) ? { documentSymbolProvider: true } : {}),
      ...(["ini", "dotenv", "zsh", "jsonl"].includes(this.language) ? { completionProvider: {} } : {}),
      ...(this.language === "csv" ? { hoverProvider: true } : {}),
    }, serverInfo: { name: `Oxbit ${this.language}` } } as T;
    if (method === "shutdown") return null as T;
    const doc = this.documents.get(params?.textDocument?.uri);
    if (!doc) throw new Error("Local language document is not open");
    let result: unknown;
    if (method === "textDocument/documentSymbol") result = localStructure(doc.language, doc.text).symbols;
    else if (method === "textDocument/completion") {
      if (doc.language === "jsonl") {
        const line = params.position.line, record = doc.text.split(/\r?\n/)[line];
        if (record === undefined) throw new Error("Invalid JSONL line");
        const document = TextDocument.create(params.textDocument.uri + `#record-${line}`, "json", doc.version, record);
        const completions = await json.doComplete(document, { line: 0, character: params.position.character }, json.parseJSONDocument(document));
        if (!completions?.items.length) {
          const prefix = record.slice(0, params.position.character), word = /(?:[:\[,]\s*)([a-z]*)$/.exec(prefix);
          if (word) {
            const start = params.position.character - word[1].length;
            result = { isIncomplete: false, items: ["true", "false", "null"].filter(label => label.startsWith(word[1])).map(label => ({ label, kind: 14, textEdit: { range: { start: { line, character: start }, end: { line, character: params.position.character } }, newText: label } })) };
          }
        }
        result ??= { ...completions, items: (completions?.items ?? []).map(item => ({ ...item, textEdit: item.textEdit && "range" in item.textEdit ? { ...item.textEdit, range: { start: { ...item.textEdit.range.start, line }, end: { ...item.textEdit.range.end, line } } } : undefined })) };
      } else {
        const { symbols } = localStructure(doc.language, doc.text);
        const names = symbols.flatMap(item => item.children ? item.children.map(child => child.name) : [item.name]);
        result = [...new Set([...names, ...(doc.language === "zsh" ? builtins : [])])].map(label => ({ label, kind: 6 }));
      }
    } else if (method === "textDocument/hover" && doc.language === "csv") {
      const parsed = parseCsv(doc.text), at = textOffset(doc.text, params.position);
      const field = parsed.rows.flat().find(item => at >= item.from && at <= item.to);
      result = field ? { contents: { kind: "plaintext", value: `Column ${field.column + 1}: ${parsed.rows[0]?.[field.column]?.value || "Unnamed"}\nRecord ${field.row + 1}` } } : null;
    } else throw new Error(`Local ${doc.language} provider does not support ${method}`);
    signal?.throwIfAborted();
    return result as T;
  }
  notify(method: string, params: any) {
    const uri = params?.textDocument?.uri;
    if (method === "textDocument/didClose") { this.documents.delete(uri); this.emit(uri, [], undefined); }
    if (method === "textDocument/didOpen") this.documents.set(uri, { text: params.textDocument.text, language: params.textDocument.languageId, version: params.textDocument.version });
    if (method === "textDocument/didChange") {
      const doc = this.documents.get(uri);
      if (!doc || params.textDocument.version <= doc.version) return;
      this.documents.set(uri, { ...doc, text: params.contentChanges.at(-1).text, version: params.textDocument.version });
    }
    if (!["textDocument/didOpen", "textDocument/didChange"].includes(method)) return;
    const doc = this.documents.get(uri)!;
    void (async () => {
      const diagnostics = doc.language === "jsonl" ? await jsonlDiagnostics(uri, doc.text, doc.version) : localStructure(doc.language, doc.text).diagnostics;
      if (this.documents.get(uri) === doc) this.emit(uri, diagnostics, doc.version);
    })();
  }
  private emit(uri: string, diagnostics: unknown[], version?: number) {
    for (const listener of this.listeners) listener("textDocument/publishDiagnostics", { uri, version, diagnostics });
  }
  onNotification(listener: (method: string, params: any) => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  dispose() { this.documents.clear(); this.listeners.clear(); }
}
