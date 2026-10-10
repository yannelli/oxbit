import nodeFs from "fs";
import nodePath from "path";
import nodeUrl from "url";
import nodeUtil from "util";
import AnalyzerModule from "bash-language-server/out/analyser.js";
import * as Builtins from "bash-language-server/out/builtins.js";
import * as ReservedWords from "bash-language-server/out/reserved-words.js";
import { setLogLevel } from "bash-language-server/out/util/logger.js";
import { analyzeFile } from "bash-language-server/out/util/shebang.js";
import { range as nodeRange } from "bash-language-server/out/util/tree-sitter.js";
import { format, initSync } from "@wasm-fmt/shfmt/web";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { NativeFileHost, Position, WorkspaceFiles } from "./files.js";
import type { NativeService } from "./server.js";

type Analyzer = InstanceType<typeof AnalyzerModule>;
type Symbol = ReturnType<Analyzer["getDeclarationsForUri"]>[number];
// Node runs analyser.js as CommonJS, so its default import is the exports object.
const AnalyzerClass: typeof AnalyzerModule = (AnalyzerModule as any).default ?? AnalyzerModule;
const SymbolKind = { Function: 12, Variable: 13 } as const;
const CompletionKind = { Function: 3, Variable: 6, Keyword: 14, Text: 1 } as const;
const scanExtensions = [".sh", ".bash", ".zsh"], scanLimit = 500, scanBudgetMs = 2000;

let workspace: WorkspaceFiles | undefined;
// On device these Node modules are empty build stubs; the analyser calls them while it resolves `source` commands and references.
const fileUri = (path: string) => "file://" + path.split("/").map(encodeURIComponent).join("/");
nodeUrl.fileURLToPath ??= ((uri: string) => decodeURIComponent(String(uri).replace(/^file:\/\//, ""))) as typeof nodeUrl.fileURLToPath;
nodeUrl.pathToFileURL ??= ((path: string) => ({ href: fileUri(path) })) as unknown as typeof nodeUrl.pathToFileURL;
nodeFs.existsSync ??= ((path: string) => workspace?.fileExists(String(path)) ?? false) as typeof nodeFs.existsSync;
nodeUtil.isDeepStrictEqual ??= (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export class ShellServer implements NativeService {
  readonly name = "Bash / Zsh (iOS)";
  readonly languages = ["shellscript", "zsh"];
  readonly capabilities = {
    completionProvider: { triggerCharacters: ["$", "{"], resolveProvider: false },
    hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true,
    documentHighlightProvider: true, documentFormattingProvider: true,
  };
  private analyzer: Analyzer;
  private analyzed = new Map<string, { text: string; open: boolean }>();

  static async create(files: WorkspaceFiles, host: NativeFileHost) {
    const resource = (name: string) => {
      const bytes = host.resource?.(name);
      if (!bytes) throw new Error(`The shell language server is missing ${name}`);
      return bytes;
    };
    // Synchronous instantiation: an app JSContext on a dispatch queue does not settle WebAssembly.instantiate promises.
    const runtime = new WebAssembly.Module(resource("web-tree-sitter.wasm"));
    await Parser.init({ instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
      const instance = new WebAssembly.Instance(runtime, imports);
      done(instance, runtime);
      return instance.exports;
    } });
    const parser = new Parser();
    parser.setLanguage(Language.loadSync(new WebAssembly.Module(resource("tree-sitter-bash.wasm"))));
    initSync(resource("shfmt.wasm"));
    return new ShellServer(files, parser);
  }

  constructor(private files: WorkspaceFiles, private parser: Parser) {
    workspace = files;
    setLogLevel("error");
    this.analyzer = new AnalyzerClass({ parser: parser as any, workspaceFolder: files.root });
    this.scan();
  }

  private uri(uri: string) { return this.files.uri(this.files.path(uri)); }

  private analyze(path: string, text: string, open: boolean) {
    const uri = this.files.uri(path);
    if (this.analyzed.get(uri)?.text === text) return void this.analyzed.set(uri, { text, open });
    const document = TextDocument.create(uri, "shellscript", 0, text) as unknown as Parameters<Analyzer["analyze"]>[0]["document"];
    this.analyzer.analyze({ document, uri, background: !open });
    this.analyzed.set(uri, { text, open });
  }

  /** Analyses up to 500 shell files so definitions and completion see the workspace. */
  private scan() {
    const deadline = Date.now() + scanBudgetMs;
    const pending = [this.files.root];
    let count = 0;
    while (pending.length && count < scanLimit && Date.now() < deadline) {
      const directory = pending.pop()!;
      for (const entry of this.files.list(directory)) {
        if (!entry.name || entry.name.includes("/") || entry.name === "." || entry.name === "..") continue;
        const path = directory + "/" + entry.name;
        if (entry.kind === "directory") { if (entry.name !== "node_modules" && entry.name !== ".git") pending.push(path); continue; }
        if (!scanExtensions.some(extension => entry.name.endsWith(extension)) || this.files.documents.has(path)) continue;
        const text = this.files.readFile(path);
        if (text === undefined || !analyzeFile(this.files.uri(path), text).dialect) continue;
        try { this.analyze(path, text, false); } catch { continue; }
        if (++count >= scanLimit || Date.now() >= deadline) break;
      }
    }
  }

  changed() {
    for (const [path, document] of this.files.documents) this.analyze(path, document.text, true);
    for (const [uri, entry] of this.analyzed) {
      const path = this.files.path(uri);
      if (entry.open && !this.files.documents.has(path)) this.analyze(path, this.files.readFile(path) ?? "", false);
    }
  }

  diagnostics(path: string) {
    const document = this.files.documents.get(path);
    // The bash grammar rejects valid zsh syntax such as `${(f)x}` and `{ cmd }`, so zsh uses shfmt's zsh parser instead.
    if (document && (document.language === "zsh" || analyzeFile(this.files.uri(path), document.text).dialect === "zsh")) return zshDiagnostics(document.text);
    const root = this.analyzer.getRootNode(this.files.uri(path)) as Node | undefined;
    const diagnostics: unknown[] = [];
    const visit = (node: Node) => {
      if (node.isError || node.isMissing) {
        diagnostics.push({ range: nodeRange(node as any), severity: 1, source: "bash", message: node.isMissing ? `Syntax error: missing "${node.type}"` : "Syntax error" });
        return;
      }
      if (node.hasError) for (const child of node.children) if (child) visit(child);
    };
    if (root?.hasError) visit(root);
    return diagnostics;
  }

  request(method: string, params: any) {
    const uri = this.uri(params.textDocument.uri), position: Position = params.position;
    const word = position && this.analyzer.wordAtPoint(uri, position.line, position.character);
    if (method === "textDocument/completion") return this.completion(uri, position);
    if (method === "textDocument/hover") return word ? this.hover(uri, position, word) : null;
    if (method === "textDocument/definition") return word ? this.analyzer.findDeclarationLocations({ position, uri, word }) : null;
    if (method === "textDocument/references") {
      const declaration = (location: { uri: string; range: { start: Position; end: Position } }) => location.uri === uri && contains(location.range, position);
      return word ? this.analyzer.findReferences(word).filter(location => params.context?.includeDeclaration || !declaration(location)) : null;
    }
    if (method === "textDocument/documentHighlight") return word ? this.analyzer.findOccurrences(uri, word).map(location => ({ range: location.range })) : [];
    if (method === "textDocument/documentSymbol") return this.analyzer.getDeclarationsForUri({ uri });
    if (method === "textDocument/formatting") return this.format(this.files.path(uri), params.options);
    throw new Error(`Unsupported shell language request: ${method}`);
  }

  private completion(uri: string, position: Position) {
    // The word ends at the cursor; looking up scope there keeps it inside the word's node at the end of a file.
    const at = { line: position.line, character: Math.max(position.character - 1, 0) };
    const word = this.analyzer.wordAtPoint(uri, at.line, at.character);
    if (word?.startsWith("#") || word === "{") return [];
    if (!word) {
      const next = this.analyzer.getDocument(uri)?.getText({ start: position, end: { ...position, character: position.character + 1 } });
      if (next !== "" && next !== " ") return [];
    }
    const variables = word === "$" || word === "${";
    const symbols = word === null ? [] : unique(variables
      ? this.analyzer.getAllVariables({ uri, position: at })
      : this.analyzer.findDeclarationsMatchingWord({ exactMatch: false, uri, word, position: at }), uri).map(symbol => ({
      label: symbol.name,
      kind: symbol.kind === SymbolKind.Function ? CompletionKind.Function : symbol.kind === SymbolKind.Variable ? CompletionKind.Variable : CompletionKind.Text,
      documentation: symbol.location.uri === uri ? undefined : this.documentation(uri, symbol),
    }));
    if (variables) return symbols;
    const items = [
      ...ReservedWords.LIST.map(label => ({ label, kind: CompletionKind.Keyword })),
      ...symbols,
      ...Builtins.LIST.map(label => ({ label, kind: CompletionKind.Function })),
    ];
    return word ? items.filter(item => item.label.startsWith(word)) : items;
  }

  private hover(uri: string, position: Position, word: string) {
    if (word.startsWith("#")) return null;
    const variable = this.analyzer.symbolAtPointFromTextPosition({ textDocument: { uri }, position })?.kind === SymbolKind.Variable;
    if (!variable && (ReservedWords.isReservedWord(word) || Builtins.isBuiltin(word))) return null;
    const documentation = unique(this.analyzer.findDeclarationsMatchingWord({ exactMatch: true, uri, word, position }), uri)
      .filter(symbol => symbol.location.uri !== uri || symbol.location.range.start.line !== position.line)
      .map(symbol => this.documentation(uri, symbol));
    return documentation.length === 1 ? { contents: documentation[0] } : null;
  }

  private documentation(uri: string, symbol: Symbol) {
    const line = symbol.location.range.start.line, comment = this.analyzer.commentsAbove(symbol.location.uri, line);
    const kind = symbol.kind === SymbolKind.Function ? "Function" : symbol.kind === SymbolKind.Variable ? "Variable" : "Keyword";
    const where = symbol.location.uri === uri ? `on line ${line + 1}` : `in ${nodePath.relative(nodePath.dirname(uri), symbol.location.uri)}`;
    return { kind: "markdown", value: `${kind}: **${symbol.name}** - *defined ${where}*${comment ? "\n\n" + comment : ""}` };
  }

  /** Formats with the zsh dialect for zsh documents and zsh shebangs, and the bash dialect otherwise. */
  private format(path: string, options?: { tabSize?: number; insertSpaces?: boolean }) {
    const document = this.files.documents.get(path)!;
    const zsh = document.language === "zsh" || analyzeFile(this.files.uri(path), document.text).dialect === "zsh";
    let text: string;
    try {
      text = format(document.text, zsh ? "document.zsh" : "document.bash", { indent: options?.insertSpaces ? options.tabSize ?? 2 : 0 });
    } catch {
      return null;
    }
    if (text === document.text) return [];
    return [{ range: { start: { line: 0, character: 0 }, end: this.files.position(path, document.text.length) }, newText: text }];
  }

  dispose() { this.parser.delete(); }
}

function contains(range: { start: Position; end: Position }, position: Position) {
  const after = (a: Position, b: Position) => a.line > b.line || a.line === b.line && a.character >= b.character;
  return after(position, range.start) && after(range.end, position);
}

/** Keeps one symbol per name and kind, preferring the current file, as bash-language-server does. */
function unique(symbols: Symbol[], uri: string) {
  const seen = new Set<string>();
  return [...symbols.filter(symbol => symbol.location.uri === uri), ...symbols.filter(symbol => symbol.location.uri !== uri)]
    .filter(symbol => !seen.has(symbol.name + symbol.kind) && seen.add(symbol.name + symbol.kind));
}

// shfmt rejects valid zsh short forms such as `for x (a b) cmd`, so only unterminated constructs, which zsh also rejects, are reported.
const zshUnterminated = /^(reached EOF without|`\w+` statement must end with|unclosed here-document)/;
function zshDiagnostics(text: string) {
  try {
    format(text, "document.zsh", {});
    return [];
  } catch (error) {
    const match = /:(\d+):(\d+): (.*)$/s.exec(String((error as Error)?.message ?? error));
    if (!match || !zshUnterminated.test(match[3]!)) return [];
    const line = Number(match[1]) - 1, lineText = text.split("\n")[line] ?? "";
    // shfmt columns count UTF-8 bytes.
    const character = new TextDecoder().decode(new TextEncoder().encode(lineText).slice(0, Number(match[2]) - 1)).length;
    const width = /^\S*/.exec(lineText.slice(character))![0].length || 1;
    return [{ range: { start: { line, character }, end: { line, character: character + width } }, severity: 1, source: "zsh", message: `Syntax error: ${match[3]}` }];
  }
}
