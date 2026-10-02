import { getLanguageService, type Diagnostic } from "vscode-json-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { WorkspaceFiles } from "./files.js";

export class JsonServer {
  private service;
  constructor(private files: WorkspaceFiles) {
    this.service = getLanguageService({
      schemaRequestService: async uri => {
        const text = this.files.readFile(this.files.path(uri));
        if (text === undefined) throw new Error("JSON schema is unavailable in this workspace");
        return text;
      },
      workspaceContext: { resolveRelativePath: (relative, resource) => {
        if (/^[a-z][a-z\d+.-]*:/i.test(relative)) return relative;
        const path = this.files.path(resource).split("/").slice(0, -1).join("/");
        return this.files.uri(relative.startsWith("/") ? relative : path + "/" + relative);
      } },
    });
  }
  private document(path: string) {
    const document = this.files.documents.get(path);
    if (!document) throw new Error("JSON language document is not open");
    return TextDocument.create(this.files.uri(path), document.language, document.version, document.text);
  }
  async diagnostics(path: string): Promise<Diagnostic[]> {
    const document = this.document(path), parsed = this.service.parseJSONDocument(document);
    return (await this.service.doValidation(document, parsed, {
      comments: document.languageId === "jsonc" ? "ignore" : "error",
      trailingCommas: document.languageId === "jsonc" ? "ignore" : "error",
    })).map(item => ({ ...item, source: "JSON" }));
  }
  async request(method: string, params: any) {
    const path = this.files.path(params.textDocument.uri), document = this.document(path), parsed = this.service.parseJSONDocument(document);
    if (method === "textDocument/completion") return this.service.doComplete(document, params.position, parsed);
    if (method === "textDocument/hover") return this.service.doHover(document, params.position, parsed);
    if (method === "textDocument/documentSymbol") return this.service.findDocumentSymbols2(document, parsed);
    throw new Error(`Unsupported JSON language request: ${method}`);
  }
  changed(settings?: any) { this.service.configure(settings?.json ?? {}); }
  dispose() { this.service.configure({ schemas: [] }); }
}
