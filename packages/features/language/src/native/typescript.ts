import ts from "typescript";
import type { WorkspaceFiles, Position } from "./files.js";
import type { NativeService } from "./server.js";

const symbols: Record<string, number> = {
  module: 2, class: 5, interface: 11, type: 11, enum: 10, "enum member": 22, method: 6, function: 12,
  property: 7, getter: 7, setter: 7, constructor: 9, const: 14, let: 13, var: 13, alias: 13,
};
const completionKinds: Record<string, number> = {
  method: 2, function: 3, constructor: 4, property: 10, var: 6, let: 6, const: 21, class: 7,
  interface: 8, module: 9, enum: 13, "enum member": 20, keyword: 14, type: 25, alias: 6,
};

export class TypeScriptServer implements NativeService {
  readonly name = "TypeScript / JavaScript (iOS)";
  readonly languages = ["typescript", "typescriptreact", "javascript", "javascriptreact"];
  readonly capabilities = {
    completionProvider: { triggerCharacters: [".", "\"", "'"], resolveProvider: true }, hoverProvider: true, documentSymbolProvider: true,
    definitionProvider: true, typeDefinitionProvider: true, implementationProvider: true, referencesProvider: true,
    renameProvider: { prepareProvider: true }, signatureHelpProvider: { triggerCharacters: ["(", ","] },
  };
  private generation = 0;
  private config: ts.ParsedCommandLine;
  private service: ts.LanguageService;
  constructor(private files: WorkspaceFiles) {
    this.config = this.configuration();
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...new Set([...this.config.fileNames, ...this.files.documents.keys()])],
      getScriptVersion: path => String(this.files.documents.get(path)?.version ?? this.generation),
      getProjectVersion: () => String(this.generation),
      getCompilationSettings: () => this.config.options,
      getProjectReferences: () => this.config.projectReferences,
      getScriptSnapshot: path => { const text = files.readFile(path); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
      getScriptKind: path => {
        const language = files.documents.get(path)?.language;
        return language === "typescriptreact" || /\.tsx$/.test(path) ? ts.ScriptKind.TSX : language === "javascriptreact" || /\.jsx$/.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      },
      getCurrentDirectory: () => files.root,
      getDefaultLibFileName: () => "/__oxbit_typescript__/lib.es2023.full.d.ts",
      fileExists: path => files.fileExists(path), readFile: path => files.readFile(path),
      directoryExists: path => files.directoryExists(path),
      getDirectories: path => files.list(path).filter(entry => entry.kind === "directory").map(entry => entry.name),
      readDirectory: (...args) => files.readDirectory(...args),
      useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    };
    this.service = ts.createLanguageService(host);
  }
  private configuration(): ts.ParsedCommandLine {
    const defaults: ts.CompilerOptions = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, allowJs: true, allowNonTsExtensions: true, noEmit: true };
    const configPath = ["tsconfig.json", "jsconfig.json"].map(name => this.files.root + "/" + name).find(path => this.files.fileExists(path));
    const text = configPath && this.files.readFile(configPath);
    const config = text ? ts.parseConfigFileTextToJson(configPath!, text) : { config: {} };
    if (config.error) return { options: defaults, fileNames: [], errors: [config.error] };
    return ts.parseJsonConfigFileContent(config.config ?? {}, {
      useCaseSensitiveFileNames: true,
      readDirectory: (...args) => this.files.readDirectory(...args),
      fileExists: path => this.files.fileExists(path), readFile: path => this.files.readFile(path),
    }, this.files.root, defaults, configPath);
  }
  changed(): void { this.generation++; this.config = this.configuration(); }
  diagnostics(path: string) {
    return [...this.service.getSyntacticDiagnostics(path), ...this.service.getSemanticDiagnostics(path)].map(item => ({
      range: this.files.range(path, { start: item.start ?? 0, length: item.length ?? 0 }),
      severity: item.category === ts.DiagnosticCategory.Error ? 1 : item.category === ts.DiagnosticCategory.Warning ? 2 : 3,
      code: item.code, source: "TypeScript", message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
    }));
  }
  request(method: string, params: any): unknown {
    if (method === "completionItem/resolve") return this.resolveCompletion(params);
    const path = this.files.path(params.textDocument.uri);
    const at = params.position ? this.files.offset(path, params.position as Position) : 0;
    if (method === "textDocument/completion") {
      const result = this.service.getCompletionsAtPosition(path, at, { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true });
      return { isIncomplete: result?.isIncomplete ?? false, items: (result?.entries ?? []).map(entry => ({
        label: entry.name, kind: completionKinds[entry.kind] ?? 1, sortText: entry.sortText,
        ...(entry.replacementSpan ? { textEdit: { range: this.files.range(path, entry.replacementSpan), newText: entry.insertText ?? entry.name } } : { insertText: entry.insertText ?? entry.name }),
        data: { path, position: at, name: entry.name, source: entry.source, data: entry.data },
      })) };
    }
    if (method === "textDocument/hover") {
      const info = this.service.getQuickInfoAtPosition(path, at);
      return info ? { range: this.files.range(path, info.textSpan), contents: { kind: "plaintext", value: [ts.displayPartsToString(info.displayParts), ts.displayPartsToString(info.documentation)].filter(Boolean).join("\n\n") } } : null;
    }
    if (method === "textDocument/definition" || method === "textDocument/typeDefinition" || method === "textDocument/implementation") {
      const definitions = method === "textDocument/typeDefinition" ? this.service.getTypeDefinitionAtPosition(path, at) : method === "textDocument/implementation" ? this.service.getImplementationAtPosition(path, at) : this.service.getDefinitionAtPosition(path, at);
      return (definitions ?? []).filter(item => this.files.normalize(item.fileName)).map(item => ({ uri: this.files.uri(item.fileName), range: this.files.range(item.fileName, item.textSpan) }));
    }
    if (method === "textDocument/references") {
      return (this.service.findReferences(path, at) ?? []).flatMap(item => item.references).filter(item => this.files.normalize(item.fileName) && (params.context?.includeDeclaration || !item.isDefinition)).map(item => ({ uri: this.files.uri(item.fileName), range: this.files.range(item.fileName, item.textSpan) }));
    }
    if (method === "textDocument/prepareRename") {
      const info = this.service.getRenameInfo(path, at, { allowRenameOfImportPath: false });
      return info.canRename ? { range: this.files.range(path, info.triggerSpan), placeholder: info.displayName } : null;
    }
    if (method === "textDocument/rename") {
      const info = this.service.getRenameInfo(path, at, { allowRenameOfImportPath: false });
      if (!info.canRename) throw new Error(info.localizedErrorMessage);
      const changes: Record<string, unknown[]> = {};
      for (const item of this.service.findRenameLocations(path, at, false, false, true) ?? []) {
        if (!this.files.normalize(item.fileName)) continue;
        (changes[this.files.uri(item.fileName)] ??= []).push({ range: this.files.range(item.fileName, item.textSpan), newText: (item.prefixText ?? "") + params.newName + (item.suffixText ?? "") });
      }
      return { changes };
    }
    if (method === "textDocument/documentSymbol") {
      const convert = (item: ts.NavigationTree): any => {
        const span = item.spans[0], selection = item.nameSpan ?? span;
        return { name: item.text, kind: symbols[item.kind] ?? 13, range: this.files.range(path, span), selectionRange: this.files.range(path, selection), children: (item.childItems ?? []).map(convert) };
      };
      return (this.service.getNavigationTree(path).childItems ?? []).map(convert);
    }
    if (method === "textDocument/signatureHelp") {
      const info = this.service.getSignatureHelpItems(path, at, undefined);
      if (!info) return null;
      return { activeSignature: info.selectedItemIndex, activeParameter: info.argumentIndex, signatures: info.items.map(item => ({
        label: ts.displayPartsToString(item.prefixDisplayParts) + item.parameters.map(parameter => ts.displayPartsToString(parameter.displayParts)).join(ts.displayPartsToString(item.separatorDisplayParts)) + ts.displayPartsToString(item.suffixDisplayParts),
        documentation: ts.displayPartsToString(item.documentation), parameters: item.parameters.map(parameter => ({ label: parameter.name, documentation: ts.displayPartsToString(parameter.documentation) })),
      })) };
    }
    throw new Error(`Unsupported TypeScript language request: ${method}`);
  }
  private resolveCompletion(item: any) {
    const data = item.data;
    if (!data) return item;
    if (!this.files.normalize(data.path)) throw new Error("Completion is outside the workspace");
    const details = this.service.getCompletionEntryDetails(data.path, data.position, data.name, {}, data.source, {}, data.data);
    return details ? { ...item, detail: ts.displayPartsToString(details.displayParts), documentation: { kind: "plaintext", value: ts.displayPartsToString(details.documentation) },
      additionalTextEdits: (details.codeActions ?? []).flatMap(action => action.changes).filter(change => change.fileName === data.path).flatMap(change => change.textChanges.map(edit => ({ range: this.files.range(data.path, edit.span), newText: edit.newText }))),
    } : item;
  }
  dispose(): void { this.service.dispose(); }
}
