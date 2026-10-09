import { DockerfileLanguageServiceFactory, type DockerfileLanguageService } from "dockerfile-language-service";
import { DockerRegistryClient } from "dockerfile-language-service/lib/dockerRegistryClient.js";
import { validate } from "dockerfile-utils";
import type { WorkspaceFiles } from "./files.js";
import type { NativeService } from "./server.js";

// Image tag completion queries Docker Hub over Node `https`; on device it returns no tags.
DockerRegistryClient.prototype.getTags = () => Promise.resolve([]);

export class DockerfileServer implements NativeService {
  readonly name = "Dockerfile (iOS)";
  readonly languages = ["dockerfile"];
  readonly capabilities = {
    completionProvider: { triggerCharacters: ["=", " ", "$", "-"], resolveProvider: true },
    hoverProvider: true, documentSymbolProvider: true, documentFormattingProvider: true,
    signatureHelpProvider: { triggerCharacters: ["-", "[", ",", " ", "="] },
  };
  private service: DockerfileLanguageService = DockerfileLanguageServiceFactory.createLanguageService();
  constructor(private files: WorkspaceFiles) {
    this.service.setCapabilities({
      completion: { completionItem: { deprecatedSupport: true, documentationFormat: ["markdown", "plaintext"] } },
      hover: { contentFormat: ["markdown", "plaintext"] },
    });
  }
  private text(path: string) {
    const document = this.files.documents.get(path);
    if (!document) throw new Error("Dockerfile language document is not open");
    return document.text;
  }
  diagnostics(path: string): unknown[] {
    return validate(this.text(path));
  }
  async request(method: string, params: any): Promise<unknown> {
    if (method === "completionItem/resolve") return this.service.resolveCompletionItem(params);
    const text = this.text(this.files.path(params.textDocument.uri));
    if (method === "textDocument/completion") return this.service.computeCompletionItems(text, params.position);
    if (method === "textDocument/hover") return this.service.computeHover(text, params.position);
    if (method === "textDocument/documentSymbol") return this.service.computeSymbols(params.textDocument, text);
    if (method === "textDocument/formatting") return this.service.format(text, params.options);
    if (method === "textDocument/signatureHelp") return this.service.computeSignatureHelp(text, params.position);
    throw new Error(`Unsupported Dockerfile language request: ${method}`);
  }
  changed() {}
  dispose() {}
}
