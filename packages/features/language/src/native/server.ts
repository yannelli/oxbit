import { WorkspaceFiles, type NativeFileHost, type ServerOptions } from "./files.js";
import { TypeScriptServer } from "./typescript.js";
import { JsonServer } from "./json.js";

export interface NativeResult {
  result?: unknown;
  error?: { code: number; message: string };
  notifications: { method: string; params: unknown }[];
}

export function createServer(options: ServerOptions, host: NativeFileHost, libraries: Record<string, string> = {}) {
  const files = new WorkspaceFiles(options, host, libraries);
  let initialized = false, closed = false;
  let service: TypeScriptServer | JsonServer | undefined;
  async function dispatch(method: string, params: any): Promise<NativeResult> {
    const notifications: NativeResult["notifications"] = [];
    const publish = async () => {
      for (const [path, document] of files.documents) {
        const diagnostics = await service!.diagnostics(path);
        if (files.documents.get(path) === document) notifications.push({ method: "textDocument/publishDiagnostics", params: { uri: files.uri(path), version: document.version, diagnostics } });
      }
    };
    try {
      if (method === "exit") { service?.dispose(); service = undefined; files.documents.clear(); closed = true; return { result: null, notifications }; }
      if (closed) throw new Error("Native language server has shut down");
      if (method === "initialize") {
        if (initialized) throw new Error("Native language server is already initialized");
        service = options.kind === "typescript" ? new TypeScriptServer(files) : new JsonServer(files);
        initialized = true;
        return { result: {
          capabilities: {
            positionEncoding: "utf-16", textDocumentSync: { openClose: true, change: 1, save: true },
            completionProvider: { triggerCharacters: options.kind === "typescript" ? [".", "\"", "'"] : ["\"", ":"], resolveProvider: options.kind === "typescript" },
            hoverProvider: true, documentSymbolProvider: true,
            ...(options.kind === "typescript" ? { definitionProvider: true, typeDefinitionProvider: true, implementationProvider: true, referencesProvider: true, renameProvider: { prepareProvider: true }, signatureHelpProvider: { triggerCharacters: ["(", ","] } } : {}),
          },
          serverInfo: { name: options.kind === "typescript" ? "TypeScript / JavaScript (iOS)" : "JSON / JSONC (iOS)" }, rootUri: files.rootUri,
        }, notifications };
      }
      if (!initialized || !service) throw new Error("Native language server is not initialized");
      if (method === "shutdown") { service.dispose(); service = undefined; files.documents.clear(); closed = true; return { result: null, notifications }; }
      if (method === "initialized" || method === "$/cancelRequest") return { result: null, notifications };
      if (method === "workspace/didChangeConfiguration" || method === "workspace/didChangeWatchedFiles") {
        service.changed(params?.settings);
        await publish();
        return { result: null, notifications };
      }
      if (method.startsWith("textDocument/did")) {
        const path = files.path(params.textDocument.uri);
        if (method === "textDocument/didOpen") {
          const { text, version, languageId } = params.textDocument;
          if (typeof text !== "string" || !Number.isInteger(version)) throw new Error("Invalid language document");
          const languages = options.kind === "typescript" ? ["typescript", "typescriptreact", "javascript", "javascriptreact"] : ["json", "jsonc"];
          if (!languages.includes(languageId)) throw new Error("Document language does not match the native server");
          files.documents.set(path, { text, version, language: languageId });
        } else if (method === "textDocument/didChange") {
          const document = files.documents.get(path);
          if (!document) throw new Error("Language document is not open");
          if (params.textDocument.version <= document.version) return { result: null, notifications };
          const change = params.contentChanges.at(-1);
          if (!Number.isInteger(params.textDocument.version) || typeof change?.text !== "string" || change.range) throw new Error("Native language servers require full document changes");
          files.documents.set(path, { ...document, text: change.text, version: params.textDocument.version });
        } else if (method === "textDocument/didClose") {
          files.documents.delete(path);
          notifications.push({ method: "textDocument/publishDiagnostics", params: { uri: params.textDocument.uri, diagnostics: [] } });
        } else if (method === "textDocument/didSave") {
          if (params.text !== undefined) {
            const document = files.documents.get(path);
            if (document) files.documents.set(path, { ...document, text: params.text });
          }
        } else throw new Error(`Unsupported native language notification: ${method}`);
        service.changed();
        await publish();
        return { result: null, notifications };
      }
      if (params?.textDocument && !files.documents.has(files.path(params.textDocument.uri))) throw new Error("Language document is not open");
      if (method === "textDocument/rename" && (typeof params.newName !== "string" || !params.newName)) throw new Error("A rename requires a name");
      return { result: await service.request(method, params) ?? null, notifications };
    } catch (error) {
      return { error: { code: -32603, message: error instanceof Error ? error.message : String(error) }, notifications };
    }
  }
  return {
    dispatch,
    handle(method: string, paramsJson: string, completion: (payload: string) => void): void {
      void Promise.resolve().then(() => dispatch(method, JSON.parse(paramsJson))).then(
        result => completion(JSON.stringify(result)),
        error => completion(JSON.stringify({ error: { code: -32603, message: String(error) }, notifications: [] })),
      );
    },
  };
}
