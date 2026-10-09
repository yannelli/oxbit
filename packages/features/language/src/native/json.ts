import { getLanguageService, type Diagnostic } from "vscode-json-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { NativeFileHost, WorkspaceFiles } from "./files.js";
import type { NativeService } from "./server.js";
import { resolveRemoteReference, Schemas, type SchemaSettings } from "./schemas.js";

export class JsonServer implements NativeService {
  readonly name = "JSON / JSONC (iOS)";
  readonly languages = ["json", "jsonc"];
  readonly capabilities = { completionProvider: { triggerCharacters: ["\"", ":"], resolveProvider: false }, hoverProvider: true, documentSymbolProvider: true };
  private service;
  private schemas: Schemas;
  constructor(private files: WorkspaceFiles, host: NativeFileHost) {
    this.schemas = new Schemas(files, host);
    this.service = getLanguageService({
      schemaRequestService: uri => this.schemas.content(uri),
      workspaceContext: { resolveRelativePath: (relative, resource) => {
        if (/^[a-z][a-z\d+.-]*:/i.test(relative)) return relative;
        if (!resource.startsWith("file:")) return resolveRemoteReference(relative, resource);
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
  async changed(settings?: unknown) {
    if (settings === undefined) return;
    this.schemas.settings = (settings as SchemaSettings | null) ?? {};
    const associations = await this.schemas.associations();
    this.service.configure({ validate: true, allowComments: true, schemas: associations.map(item => ({ uri: item.url, fileMatch: item.fileMatch })) });
  }
  dispose() { this.service.configure({ schemas: [] }); }
}
