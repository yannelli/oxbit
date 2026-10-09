import { getLanguageService, SchemaPriority, type LanguageService } from "yaml-language-server/lib/esm/languageservice/yamlLanguageService.js";
import type { SettingsState } from "yaml-language-server/lib/esm/yamlSettings.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { NativeFileHost, WorkspaceFiles } from "./files.js";
import type { NativeService } from "./server.js";
import { resolveRemoteReference, Schemas, type SchemaAssociation, type SchemaSettings } from "./schemas.js";

/** YAML documents are `*.yml`/`*.yaml` or extensionless names such as `.yamllint`. */
const yamlPattern = (pattern: string) => /\.ya?ml$/i.test(pattern) || /(^|\/)\.?[^/.]+$/.test(pattern);
export function yamlAssociations(associations: SchemaAssociation[]): SchemaAssociation[] {
  return associations.map(item => ({ url: item.url, fileMatch: item.fileMatch.filter(yamlPattern) })).filter(item => item.fileMatch.length);
}

export class YamlServer implements NativeService {
  readonly name = "YAML (iOS)";
  readonly languages = ["yaml"];
  readonly capabilities = {
    completionProvider: { triggerCharacters: [":", " ", "-"], resolveProvider: false },
    hoverProvider: true, documentSymbolProvider: true, documentFormattingProvider: true,
  };
  private service: LanguageService;
  private schemas: Schemas;
  constructor(private files: WorkspaceFiles, host: NativeFileHost) {
    this.schemas = new Schemas(files, host);
    // Associations come from the host schema cache, so the service's own SchemaStore and Kubernetes CRD downloads stay off.
    const yamlSettings = { schemaStoreEnabled: false, kubernetesCRDStoreEnabled: false, locale: "en" } as Partial<SettingsState> as SettingsState;
    this.service = getLanguageService({
      schemaRequestService: uri => this.schemas.content(uri),
      workspaceContext: { resolveRelativePath: (relative, resource) => this.resolve(relative, resource) },
      yamlSettings,
    });
  }
  private resolve(relative: string, resource: string): string {
    if (/^[a-z][a-z\d+.-]*:/i.test(relative)) return relative;
    const base = resource.replace(/#.*$/, "");
    if (!relative || relative.startsWith("#")) return base + relative;
    if (!base.startsWith("file:")) return resolveRemoteReference(relative, base);
    const [path, suffix = ""] = /^([^?#]*)(.*)$/.exec(relative)!.slice(1);
    const directory = this.files.path(base).split("/").slice(0, -1).join("/");
    return this.files.uri(path.startsWith("/") ? path : directory + "/" + path) + suffix;
  }
  private document(path: string) {
    const document = this.files.documents.get(path);
    if (!document) throw new Error("YAML language document is not open");
    return TextDocument.create(this.files.uri(path), document.language, document.version, document.text);
  }
  async diagnostics(path: string) {
    return (await this.service.doValidation(this.document(path), false)).map(item => ({ ...item, source: item.source ?? "YAML" }));
  }
  async request(method: string, params: any) {
    const document = this.document(this.files.path(params.textDocument.uri));
    if (method === "textDocument/completion") return this.service.doComplete(document, params.position, false);
    if (method === "textDocument/hover") return this.service.doHover(document, params.position);
    if (method === "textDocument/documentSymbol") return this.service.findDocumentSymbols2(document);
    if (method === "textDocument/formatting") return this.service.doFormat(document, { printWidth: 80, proseWrap: "preserve", ...params.options });
    throw new Error(`Unsupported YAML language request: ${method}`);
  }
  async changed(settings?: unknown) {
    if (settings === undefined) return;
    this.schemas.settings = (settings as SchemaSettings | null) ?? {};
    const associations = yamlAssociations(await this.schemas.associations());
    this.service.configure({
      validate: true, hover: true, completion: true, format: true, isKubernetes: false, yamlVersion: "1.2",
      schemas: associations.map(item => ({ uri: item.url, fileMatch: item.fileMatch, priority: SchemaPriority.SchemaStore })),
    });
  }
  dispose() { this.service.configure({ schemas: [] }); }
}
