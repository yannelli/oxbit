import { compositeCapabilities, compositeItems } from "./lsp-composite.js";
import { ExternalSources } from "./external-sources.js";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource, ResponseError, type MessageConnection } from "vscode-jsonrpc/node.js";
import type { ServerCapabilities } from "vscode-languageserver-protocol";
import { BoundedLspStream } from "./lsp-stream.js";
import type { LaunchSpec } from "./managed/catalog.js";
import { resolveLanguage, synchronization, incrementalChange, textOffset, effectiveCapabilities, lspCapabilityKeys, registrationMatches, lspGlobMatches, lspWatchPattern, type LspRegistration } from "@oxbit/sdk";
export interface ServerOptions {
  name?: string;
  root?: string;
  prepare?: (signal: AbortSignal) => Promise<LaunchSpec>;
  onServerMessage?: (method: string, params: any) => boolean;
}
import { trackChild } from "./owned-processes.js";
import { setting } from "./branding.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { RpcError } from "@oxbit/protocol";
import { WorkspaceFiles } from "./filesystem.js";
import { killProcess } from "./process-lifecycle.js";

/** LSP data is server-owned metadata, including virtual document URIs for embedded languages.
 * Exclude only protocol-defined opaque fields from path validation; send the original params.
 */
function requestParamsForValidation(method: string, params: any) {
  const withoutData = (item: any) => item && typeof item === "object" && !Array.isArray(item) ? { ...item, data: undefined } : item;
  const diagnostics = (items: any) => Array.isArray(items) ? items.map(withoutData) : items;
  switch (method) {
    case "completionItem/resolve":
    case "inlayHint/resolve":
    case "documentLink/resolve":
    case "workspaceSymbol/resolve":
      return withoutData(params);
    case "codeAction/resolve":
      return { ...withoutData(params), diagnostics: diagnostics(params?.diagnostics) };
    case "textDocument/codeAction":
      return { ...params, context: { ...params?.context, diagnostics: diagnostics(params?.context?.diagnostics) } };
    case "callHierarchy/incomingCalls":
    case "callHierarchy/outgoingCalls":
    case "typeHierarchy/supertypes":
    case "typeHierarchy/subtypes":
      return { ...params, item: withoutData(params?.item) };
    default:
      return params;
  }
}

export class LanguageServer {
  readonly external = new ExternalSources();
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private rpc?: MessageConnection;
  private incoming = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private starting?: Promise<unknown>;
  private capabilities?: ServerCapabilities;
  private primaryCapabilities?: ServerCapabilities;
  private primaryDiagnostics = new Map<string, any[]>();
  private companionDiagnostics = new Map<string, any[]>();
  private paused = false;
  private preparation = new AbortController();
  private launchSpec?: LaunchSpec;
  private phase = "stopped";
  private error = "";
  private output: string[] = [];
  private companion?: LanguageServer;
  private generation = 0;
  private registrations = new Map<string, LspRegistration>();
  private serverName = setting("LSP_COMMAND") ? "Workspace language server" : "TypeScript / JavaScript";
  status() {
    return {
      state: this.starting ? this.phase : this.capabilities ? "ready" : this.phase,
      generation: this.generation, version: this.launchSpec?.version, error: this.error, output: [...this.output],
      projectRootUri: pathToFileURL(this.options.root ?? this.files.root).href,
      paused: this.paused,
      name: this.serverName,
      rootUri: this.uri(""),
      capabilities: this.capabilities, registrations: [...this.registrations.values()],
    };
  }
  private effective(uri?: string) {
    const doc = uri ? this.documents.get(uri) : undefined;
    return effectiveCapabilities(this.capabilities ?? {}, this.registrations.values(), doc && uri ? { path: path.relative(this.files.root, fileURLToPath(uri)).split(path.sep).join("/"), language: doc.languageId } : undefined);
  }
  private syncOptions(uri: string) {
    const result = { ...synchronization(this.capabilities ?? {}) };
    const doc = this.documents.get(uri);
    for (const registration of this.registrations.values()) {
      if (!registrationMatches(registration.registerOptions?.documentSelector, doc ? { path: path.relative(this.files.root, fileURLToPath(uri)), language: doc.languageId } : undefined)) continue;
      if (registration.method === "textDocument/didOpen" || registration.method === "textDocument/didClose") result.openClose = true;
      if (registration.method === "textDocument/didChange") result.change = registration.registerOptions?.syncKind ?? 0;
      if (registration.method === "textDocument/didSave") result.save = registration.registerOptions ?? true;
      if (registration.method === "textDocument/willSave") result.willSave = true;
      if (registration.method === "textDocument/willSaveWaitUntil") result.willSaveWaitUntil = true;
    }
    return result;
  }
  private opened(uri: string) {
    const doc = this.documents.get(uri);
    if (doc && this.capabilities && this.syncOptions(uri).openClose) this.send({ method: "textDocument/didOpen", params: { textDocument: { uri, ...doc, canonical: undefined } } });
  }
  private changedDocument(uri: string, previous: string) {
    this.primaryDiagnostics.delete(uri); this.companionDiagnostics.delete(uri);
    const doc = this.documents.get(uri), kind = this.syncOptions(uri).change;
    if (doc && this.capabilities && kind) this.send({ method: "textDocument/didChange", params: { textDocument: { uri, version: doc.version }, contentChanges: [kind === 2 ? incrementalChange(previous, doc.text) : { text: doc.text }] } });
  }
  saved(relative: string, text: string) {
    const uri = this.uri(relative), doc = this.documents.get(uri), save = this.syncOptions(uri).save;
    if (this.capabilities && doc && doc.text === text && save) this.send({ method: "textDocument/didSave", params: { textDocument: { uri }, ...(typeof save === "object" && save.includeText ? { text } : {}) } });
    this.companion?.saved(relative, text);
  }
  async watched(relative: string, type: number) {
    if (!this.capabilities) return;
    await this.companion?.watched(relative, type);
    await this.files.resolve(relative, true);
    const full = path.join(this.files.root, relative), projectRoot = this.options.root ?? this.files.root;
    if (full !== projectRoot && !full.startsWith(projectRoot + path.sep)) return;
    const projectRelative = path.relative(projectRoot, full).split(path.sep).join("/");
    const matches = [...this.registrations.values()].some(registration => registration.method === "workspace/didChangeWatchedFiles" && registration.registerOptions?.watchers?.some((watcher: any) => {
      const pattern = lspWatchPattern(watcher.globPattern, pathToFileURL(projectRoot).href);
      return typeof pattern === "string" && ((watcher.kind ?? 7) & (1 << (type - 1))) && lspGlobMatches(pattern, projectRelative);
    }));
    if (matches) this.send({ method: "workspace/didChangeWatchedFiles", params: { changes: [{ uri: this.uri(relative), type }] } });
  }
  private commandQueue: Promise<unknown> = Promise.resolve();
  private applyEdit?: (edit:unknown,label?:string)=>Promise<{applied:boolean;failureReason?:string}>;
  private documents = new Map<
    string,
    { text: string; version: number; languageId: string; canonical: boolean }
  >();
  constructor(
    private files: WorkspaceFiles,
    private emit: (method: string, params: any) => void,
    private options: ServerOptions = {},
  ) { if (options.name) this.serverName = options.name; }
  versions() {
    return Object.fromEntries(
      [...this.documents].map(([uri, doc]) => [uri, doc.version]),
    );
  }
  uri(relative: string) {
    return pathToFileURL(path.join(this.files.root, relative)).href;
  }
  async validate(value: unknown, external = false): Promise<void> {
    if (Array.isArray(value)) {
      for (const child of value) await this.validate(child, external);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (
          ["uri", "oldUri", "newUri", "rootUri", "targetUri"].includes(key) &&
          typeof child === "string"
        ) {
          if (!child.startsWith("file:"))
            throw new RpcError(
              "PATH_DENIED",
              "Language service requires workspace file URIs",
            );
          const full = fileURLToPath(child);
          if (!this.files.inside(full)) {
            if (external) { await this.external.authorize(child); continue; }
            throw new RpcError(
              "PATH_DENIED",
              "Language service URI leaves workspace",
            );
          }
          await this.files.resolve(path.relative(this.files.root, full), true);
        } else await this.validate(child, external);
      }
    }
  }
  private send(message: any) {
    if (message.id !== undefined && !message.method) {
      const pending = this.incoming.get(message.id);
      if (!pending) return;
      this.incoming.delete(message.id);
      if (message.error) pending.reject(new ResponseError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if (!this.rpc) throw new RpcError("LSP_UNAVAILABLE", "Language server is stopped");
    void this.rpc.sendNotification(message.method, ...(Array.isArray(message.params) ? message.params : [message.params])).catch(error => { if (this.rpc) this.emit("window/logMessage", { type: 1, message: String(error) }); });
  }
  private async rawRequest(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (!this.rpc) throw new RpcError("LSP_UNAVAILABLE", "Language server is stopped");
    signal?.throwIfAborted();
    const source = new CancellationTokenSource();
    const abort = () => source.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.rpc.sendRequest(method, params, source.token),
        new Promise((_, reject) => {
          timer = setTimeout(() => { reject(new RpcError("LSP_TIMEOUT", `${method} exceeded 30 seconds`)); source.cancel(); }, 30000);
          timer.unref();
          source.token.onCancellationRequested(() => reject(new RpcError("CANCELLED", "Language request was cancelled")));
        }),
      ]);
    } catch (error) {
      if (error instanceof ResponseError) throw new RpcError("LSP_ERROR", error.message, { code: error.code, data: error.data });
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); source.dispose(); }
  }
  async start(resume = false): Promise<any> {
    if (resume) this.paused = false;
    if (!resume && this.phase === "failed") throw new RpcError("LSP_FAILED", this.error || "Language server failed. Retry from Language Servers.");
    if (this.paused) throw new RpcError("LSP_STOPPED", "Language server is stopped. Start it from Language Servers.");
    if (this.starting) return this.starting;
    if (this.child && this.capabilities)
      return { capabilities: this.capabilities, registrations: [...this.registrations.values()], rootUri: this.uri(""), projectRootUri: pathToFileURL(this.options.root ?? this.files.root).href, version: this.launchSpec?.version };
    this.error = "";
    this.phase = this.options.prepare ? "installing" : "starting";
    this.emit("oxbit/serverState", { state: this.phase });
    this.preparation = new AbortController();
    this.generation++;
    this.starting = this.launch();
    try {
      return await this.starting;
    } catch (error) {
      const child = this.child;
      if (child) killProcess(child);
      this.failed(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.starting = undefined;
    }
  }
  private async launch() {
    this.launchSpec = await this.options.prepare?.(this.preparation.signal);
    this.preparation.signal.throwIfAborted();
    await this.external.register(this.launchSpec?.dependencyRoots ?? []);
    this.phase = "starting";
    this.emit("oxbit/serverState", { state: "starting", version: this.launchSpec?.version });
    if (this.launchSpec?.companion) {
      const companion = this.launchSpec.companion;
      this.companion = new LanguageServer(this.files, (method, params) => {
        if (method === "textDocument/publishDiagnostics") {
          const version = this.companion?.versions()[params.uri];
          if (params.version !== undefined && params.version !== version) return;
          this.companionDiagnostics.set(params.uri, params.diagnostics ?? []);
          this.emit(method, { ...params, version: this.documents.get(params.uri)?.version, diagnostics: [...(this.primaryDiagnostics.get(params.uri) ?? []), ...(params.diagnostics ?? [])] });
        } else if (method === "window/logMessage" || method === "$/progress") this.emit(method, params);
        else if (method === "oxbit/serverState" && params.error && this.child) { const child = this.child; killProcess(child); this.failed(new Error(`Vue companion failed: ${params.error}`)); }
      }, { root: this.options.root, name: "Vue TypeScript companion", prepare: async () => companion });
      for (const [uri, doc] of this.documents) this.companion.canonical(path.relative(this.files.root, fileURLToPath(uri)), doc.text, doc.languageId === "vue" ? "typescript" : doc.languageId);
      await this.companion.start();
    }
    const command = this.launchSpec?.executable ?? (setting("LSP_COMMAND") || process.execPath);
    const args = this.launchSpec?.args ?? (setting("LSP_COMMAND")
      ? ["--stdio"]
      : [
          path.join(
            path.dirname(
              createRequire(import.meta.url).resolve(
                "typescript-language-server/package.json",
              ),
            ),
            "lib/cli.mjs",
          ),
          "--stdio",
        ]);
    this.child = spawn(command, args, {
      cwd: this.options.root ?? this.files.root,
      env: { ...process.env, ...this.launchSpec?.env },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    trackChild(this.child);
    const bounded = new BoundedLspStream();
    this.child.stdout.pipe(bounded);
    const connection = createMessageConnection(new StreamMessageReader(bounded), new StreamMessageWriter(this.child.stdin));
    this.rpc = connection;
    bounded.on("error", error => { if (this.rpc === connection) { const child = this.child; if (child) killProcess(child); this.failed(error); } });
    connection.onRequest((method: string, ...arguments_: any[]) => new Promise((resolve, reject) => {
      const values = arguments_.slice(0, -1), params = values.length === 1 ? values[0] : values;
      const id = --this.sequence;
      const token = arguments_.at(-1);
      const cancellation = token.onCancellationRequested(() => { this.incoming.delete(id); cancellation.dispose(); reject(new ResponseError(-32800, "Server request cancelled")); });
      this.incoming.set(id, { resolve: value => { cancellation.dispose(); resolve(value); }, reject: error => { cancellation.dispose(); reject(error); } });
      if (token.isCancellationRequested) { this.send({ id, error: { code: -32800, message: "Server request cancelled" } }); return; }
      try { this.receive({ id, method, params }); } catch (error) { cancellation.dispose(); this.incoming.delete(id); reject(error); }
    }));
    connection.onNotification((method, ...values) => this.receive({ method, params: values.length === 1 ? values[0] : values }));
    connection.onError(([error]) => { if (this.rpc === connection) { const child = this.child; if (child) killProcess(child); this.failed(new Error(`Invalid language protocol: ${error.message}`)); } });
    connection.onClose(() => { if (this.rpc === connection) { const child = this.child; if (child) killProcess(child); this.failed(new Error("Language server closed its protocol stream")); } });
    connection.listen();
    this.child.stderr.on("data", (data: Buffer) => {
      let message = data.toString().slice(0, 16000);
      const key = this.launchSpec?.initializationOptions?.licenceKey;
      if (typeof key === "string" && key) message = message.replaceAll(key, "[redacted]");
      this.output.push(message); while (this.output.join("").length > 16000) this.output.shift();
      this.emit("window/logMessage", { type: 4, message });
    });
    const launched = this.child;
    this.child.on("error", (error) => {
      if (this.child === launched) this.failed(error);
    });
    this.child.on("exit", (code) => {
      if (this.child === launched)
        this.failed(
          new RpcError("LSP_EXIT", `Language server exited (${code})`),
        );
    });
    const initialized = await this.rawRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.options.root ?? this.files.root).href,
      initializationOptions: this.launchSpec?.initializationOptions,
      workspaceFolders: [
        { uri: pathToFileURL(this.options.root ?? this.files.root).href, name: path.basename(this.options.root ?? this.files.root) },
      ],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: {
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
          configuration: true, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true }, semanticTokens: { refreshSupport: true }, inlayHint: { refreshSupport: true },
        },
        textDocument: {
          synchronization: { dynamicRegistration: true, didSave: true, willSave: true, willSaveWaitUntil: true },
          completion: { dynamicRegistration: true, completionList: { itemDefaults: ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode", "data"] }, completionItem: { snippetSupport: true, commitCharactersSupport: true, insertReplaceSupport: true, documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits", "command"] } } },
          hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: { versionSupport: true },
          semanticTokens: { requests: { range: true, full: { delta: true } }, tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"], tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"], formats: ["relative"], overlappingTokenSupport: false, multilineTokenSupport: false },
          inlayHint: { dynamicRegistration: true, resolveSupport: { properties: ["tooltip", "textEdits", "label.tooltip", "label.location"] } },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["quickfix", "refactor", "source.organizeImports"],
              },
            },
          },
        },
      },
      clientInfo: { name: "Oxbit", version: "0.1.0" },
    }, this.preparation.signal);
    if (initialized.capabilities?.positionEncoding && initialized.capabilities.positionEncoding !== "utf-16") throw new Error("Unsupported server position encoding");
    this.primaryCapabilities = initialized.capabilities;
    this.capabilities = compositeCapabilities(initialized.capabilities, this.companion?.status().capabilities);
    if (initialized.serverInfo?.name) this.serverName = initialized.serverInfo.name;
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    if (this.launchSpec?.settings) this.send({ jsonrpc: "2.0", method: "workspace/didChangeConfiguration", params: { settings: this.launchSpec.settingsSection ? this.launchSpec.settings[this.launchSpec.settingsSection] : this.launchSpec.settings } });
    for (const uri of this.documents.keys()) this.opened(uri);
    this.phase = "ready";
    this.emit("oxbit/serverState", { state: "running", name: this.serverName });
    return { capabilities: this.capabilities, registrations: [...this.registrations.values()], rootUri: this.uri(""), projectRootUri: pathToFileURL(this.options.root ?? this.files.root).href, version: this.launchSpec?.version };
  }
  private receive(message: any) {
    if (setting("LSP_TRACE")) this.emit("window/logMessage", { type: 4, message: `${this.serverName}: ${message.method ?? "response"}` });
    if (message.id !== undefined && message.method) {
      if (message.method === "vscode/content" && this.launchSpec?.schemaContent) {
        const connection = this.rpc;
        const uri = Array.isArray(message.params) && message.params.length === 1 ? message.params[0] : message.params;
        void this.launchSpec.schemaContent(uri).then(
          result => { if (this.rpc === connection) this.send({ id: message.id, result }); },
          error => { if (this.rpc === connection) this.send({ id: message.id, error: { code: -32603, message: String(error) } }); },
        );
        return;
      }
      if (["workspace/semanticTokens/refresh", "workspace/inlayHint/refresh"].includes(message.method)) {
        this.emit("oxbit/refresh", { method: message.method }); this.send({ id: message.id, result: null }); return;
      }
      if (message.method === "window/showMessageRequest") {
        const connection = this.rpc;
        const timer = setTimeout(() => { if (this.rpc === connection) this.send({ id: message.id, result: null }); }, 30000);
        timer.unref();
        this.emit("oxbit/serverRequest", { id: message.id, method: message.method, params: message.params });
        return;
      }
      if (message.method === "workspace/applyEdit") {
        const child = this.child;
        void (async () => { await this.validate(message.params?.edit); return this.applyEdit ? await this.applyEdit(message.params.edit,message.params.label) : {applied:false,failureReason:"No initiating document client is available"}; })().catch(error=>({applied:false,failureReason:String(error)})).then(result=>{ if(this.child===child) this.send({jsonrpc:"2.0",id:message.id,result}); });
        return;
      }
      if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
        const adding = message.method === "client/registerCapability";
        const registrations = adding ? message.params?.registrations : message.params?.unregisterations;
        const syncMethods = ["textDocument/didOpen", "textDocument/didClose", "textDocument/didChange", "textDocument/didSave", "textDocument/willSave", "textDocument/willSaveWaitUntil"];
        const supported = (item: any) => item && typeof item.id === "string" && (lspCapabilityKeys[item.method] || syncMethods.includes(item.method) || item.method === "workspace/didChangeConfiguration" || item.method === "workspace/didChangeWorkspaceFolders" || item.method === "workspace/didChangeWatchedFiles" && Array.isArray(item.registerOptions?.watchers) && item.registerOptions.watchers.every((watcher: any) => lspWatchPattern(watcher.globPattern, pathToFileURL(this.options.root ?? this.files.root).href) !== undefined && (watcher.kind === undefined || Number.isInteger(watcher.kind) && watcher.kind >= 1 && watcher.kind <= 7)));
        if (!Array.isArray(registrations) || new Set(registrations.map(item => item?.id)).size !== registrations.length || registrations.some(item => adding ? !supported(item) || this.registrations.has(item.id) : this.registrations.get(item.id)?.method !== item.method)) {
          this.send({ id: message.id, error: { code: -32602, message: "Unsupported or unknown capability registration" } });
        } else {
          const previousSync = new Map([...this.documents.keys()].map(uri => [uri, this.syncOptions(uri).openClose]));
          for (const item of registrations) { if (adding) this.registrations.set(item.id, item); else this.registrations.delete(item.id); }
          this.send({ id: message.id, result: null });
          for (const [uri, wasOpen] of previousSync) {
            const isOpen = this.syncOptions(uri).openClose;
            if (!wasOpen && isOpen) this.opened(uri);
            else if (wasOpen && !isOpen) this.send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
          }
          this.emit("oxbit/capabilities", { capabilities: this.capabilities, registrations: [...this.registrations.values()] });
        }
        return;
      }
      if (message.method === "workspace/workspaceFolders") {
        this.send({ jsonrpc: "2.0", id: message.id, result: [{ uri: pathToFileURL(this.options.root ?? this.files.root).href, name: path.basename(this.options.root ?? this.files.root) }] }); return;
      }
      if (message.method === "workspace/configuration")
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: (message.params?.items ?? []).map((item: { section?: string; scopeUri?: string }) => {
            if (item.scopeUri) {
              try { const scope = fileURLToPath(item.scopeUri), root = this.options.root ?? this.files.root; if (scope !== root && !scope.startsWith(root + path.sep)) return null; } catch { return null; }
            }
            const settings = this.launchSpec?.settings ?? {};
            if (!item.section) return settings;
            if (Object.hasOwn(settings, item.section)) return settings[item.section];
            return item.section.split(".").reduce((value: any, key: string) => value?.[key], settings) ?? null;
          }),
        });
      else if (
        message.method === "window/workDoneProgress/create"
      )
        this.send({ jsonrpc: "2.0", id: message.id, result: null });
      else this.send({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:`Unsupported server request ${message.method}`}});
      return;
    }
    if (message.method === "tsserver/request" && this.companion) {
      const child = this.child;
      for (const [id, command, payload] of (Array.isArray(message.params?.[0]) ? message.params : [message.params])) void this.companion.request("workspace/executeCommand", {
        command: "typescript.tsserverRequest", arguments: [command, payload],
      }).catch(() => null).then(result => { if (this.child === child) this.send({ jsonrpc: "2.0", method: "tsserver/response", params: Array.isArray(message.params?.[0]) ? [[id, result?.body ?? null]] : [id, result?.body ?? null] }); });
      return;
    }
    if (message.method === "textDocument/publishDiagnostics" && this.companion) {
      this.primaryDiagnostics.set(message.params.uri, message.params.diagnostics ?? []);
      this.emit(message.method, { ...message.params, diagnostics: [...(message.params.diagnostics ?? []), ...(this.companionDiagnostics.get(message.params.uri) ?? [])] }); return;
    }
    if (message.method && !this.options.onServerMessage?.(message.method, message.params)) this.emit(message.method, message.params);
  }
  respond(id: number, result: unknown) { this.send({ id, result }); }
  private failed(error: Error) {
    this.external.clear();
    for (const pending of this.incoming.values()) pending.reject(error);
    this.incoming.clear();
    const connection = this.rpc; this.rpc = undefined; connection?.dispose();
    this.child = undefined;
    this.capabilities = undefined;
    this.primaryCapabilities = undefined;
    this.primaryDiagnostics.clear(); this.companionDiagnostics.clear();
    this.registrations.clear();
    const stopped = error instanceof RpcError && error.code === "LSP_STOPPED";
    this.phase = stopped ? "stopped" : "failed";
    this.error = stopped ? "" : error.message;
    if (this.companion) { void this.companion.stop(); this.companion = undefined; }
    this.emit("oxbit/serverState", {
      state: "stopped", paused: this.paused,
      ...(error instanceof RpcError && error.code === "LSP_STOPPED" ? {} : { error: error.message }),
    });
  }
  private async providerRequest(method: string, params: any, signal?: AbortSignal): Promise<any> {
    const companion = this.companion;
    if (!companion) return this.rawRequest(method, params, signal);
    if (method === "textDocument/completion") {
      const values = await Promise.allSettled([this.primaryCapabilities?.completionProvider ? this.rawRequest(method, params, signal) : Promise.resolve(null), companion.request(method, params, signal)]);
      if (values.every(value => value.status === "rejected")) throw (values[0] as PromiseRejectedResult).reason;
      return { isIncomplete: values.some(value => value.status === "fulfilled" && value.value?.isIncomplete), items: values.flatMap((value, index) => value.status === "fulfilled" ? compositeItems(value.value, index ? "companion" : "primary") : []) };
    }
    if (method === "completionItem/resolve" && params.data?.__oxbitSource) {
      const source = params.data.__oxbitSource, item = { ...params, data: params.data.original };
      const result = source === "companion" ? await companion.request(method, item, signal) : await this.rawRequest(method, item, signal);
      return { ...result, data: { __oxbitSource: source, original: result?.data } };
    }
    const capability = lspCapabilityKeys[method] ?? (method === "textDocument/prepareRename" ? "renameProvider" : method.startsWith("callHierarchy/") ? "callHierarchyProvider" : method.startsWith("typeHierarchy/") ? "typeHierarchyProvider" : undefined);
    if (capability && (companion.status().capabilities as any)?.[capability]) {
      if (!(this.primaryCapabilities as any)?.[capability]) return companion.request(method, params, signal);
      const value = await this.rawRequest(method, params, signal);
      if (value === null || Array.isArray(value) && !value.length) return companion.request(method, params, signal);
      return value;
    }
    return this.rawRequest(method, params, signal);
  }
  async request(method: string, params: unknown, signal?: AbortSignal, applyEdit?: (edit:unknown,label?:string)=>Promise<{applied:boolean;failureReason?:string}>): Promise<any> {
    await this.start(); await this.validate(requestParamsForValidation(method, params), /^(callHierarchy|typeHierarchy)\//.test(method));
    if (method !== "workspace/executeCommand") {
      const uri = (params as any)?.textDocument?.uri, doc = this.documents.get(uri), version = doc?.version, generation = this.generation;
      const capability = lspCapabilityKeys[method];
      if (capability && !this.effective(uri)[capability]) throw new RpcError("LSP_UNSUPPORTED", `Language server does not support ${method}`);
      if (method === "textDocument/willSaveWaitUntil" && !this.syncOptions(uri).willSaveWaitUntil) return [];
      const result = await this.providerRequest(method, params, signal);
      if (generation !== this.generation || doc && doc.version !== version) throw new RpcError("CANCELLED", "Language response is obsolete");
      return result;
    }
    if (this.companion && !(this.primaryCapabilities?.executeCommandProvider?.commands ?? []).includes((params as any)?.command) && (this.companion.status().capabilities?.executeCommandProvider?.commands ?? []).includes((params as any)?.command)) return this.companion.request(method, params, signal, applyEdit);
    const operation = this.commandQueue.catch(()=>{}).then(async()=>{
      let rejected:string|undefined;
      this.applyEdit = async(edit,label)=>{ let result:{applied:boolean;failureReason?:string}; try { result=applyEdit ? await applyEdit(edit,label) : {applied:false,failureReason:"No initiating document client is available"}; } catch(error) {result={applied:false,failureReason:String(error)};} if (!result.applied) rejected=result.failureReason??"Workspace edit was rejected"; return result; };
      try { const result=await this.rawRequest(method,params,signal); if (rejected) throw new RpcError("LSP_EDIT_REJECTED",rejected); return result; } finally { this.applyEdit=undefined; }
    });
    this.commandQueue=operation; return operation;
  }
  schemaChanged(uri: string) {
    if (this.capabilities) this.send({ method: "json/schemaContent", params: uri });
  }
  async notify(method: string, params: any) {
    await this.validate(params);
    if (
      ![
        "textDocument/didOpen",
        "textDocument/didChange",
        "textDocument/didClose",
        "textDocument/didSave",
        "textDocument/willSave",
        "workspace/didChangeConfiguration",
        "workspace/didChangeWatchedFiles",
        "$/setTrace",
      ].includes(method)
    )
      throw new RpcError("INVALID_PARAMS", "Unsupported client notification");
    const uri = params?.textDocument?.uri,
      existing = uri ? this.documents.get(uri) : undefined;
    if (
      uri &&
      existing?.canonical &&
      [
        "textDocument/didOpen",
        "textDocument/didChange",
        "textDocument/didClose",
      ].includes(method)
    )
      return;
    const previous = existing?.text;
    if (method === "textDocument/didOpen") {
      if (existing && (params.textDocument.version < existing.version || params.textDocument.text === existing.text)) return;
      this.documents.set(uri, { text: params.textDocument.text, version: params.textDocument.version, languageId: params.textDocument.languageId, canonical: false });
    }
    if (method === "textDocument/didChange") {
      if (!existing) throw new RpcError("NOT_OPEN", "Language document is not open");
      if (params.textDocument.version <= existing.version) return;
      let text = existing.text;
      for (const change of params.contentChanges ?? []) {
        if (change.range) {
          const start = textOffset(text, change.range.start), end = textOffset(text, change.range.end);
          if (start > end) throw new RpcError("INVALID_PARAMS", "Reversed language edit");
          text = text.slice(0, start) + change.text + text.slice(end);
        } else text = change.text;
      }
      existing.text = text; existing.version = params.textDocument.version;
    }
    if ((method === "textDocument/didOpen" || method === "textDocument/didChange") && this.companion) {
      const document = this.documents.get(uri)!;
      this.companion.canonical(path.relative(this.files.root, fileURLToPath(uri)), document.text, document.languageId === "vue" ? "typescript" : document.languageId);
    }
    if (method === "textDocument/didClose") { this.closeDocument(path.relative(this.files.root, fileURLToPath(uri))); return; }
    if (this.paused) return;
    const running = !!this.capabilities;
    await this.start();
    if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
      if (running) { if (previous === undefined) this.opened(uri); else this.changedDocument(uri, previous); }
    } else if (method === "textDocument/didSave") {
      if (existing) this.saved(path.relative(this.files.root, fileURLToPath(uri)), existing.text);
    } else if (method !== "textDocument/willSave" || this.syncOptions(uri).willSave) this.send({ method, params });
  }
  closeDocument(relative: string) {
    this.companion?.closeDocument(relative);
    const uri = this.uri(relative), openClose = this.syncOptions(uri).openClose;
    if (!this.documents.delete(uri)) return;
    this.primaryDiagnostics.delete(uri); this.companionDiagnostics.delete(uri);
    if (this.capabilities && openClose) this.send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
  }
  closeCanonical(relative: string) { if (this.documents.get(this.uri(relative))?.canonical) this.closeDocument(relative); }
  canonical(relative: string, text: string, language?: string) {
    const uri = this.uri(relative), existing = this.documents.get(uri), languageId = language ?? resolveLanguage(relative, { firstLine: text.split("\n", 1)[0] }).id;
    if (existing && existing.languageId !== languageId) this.closeDocument(relative);
    // TLS accepts TypeScript wire documents; the matching Vue plugin handles their .vue paths.
    this.companion?.canonical(relative, text, languageId === "vue" ? "typescript" : languageId);
    const current = this.documents.get(uri);
    if (current) {
      current.canonical = true;
      if (current.text === text) return;
      const previous = current.text;
      current.text = text; current.version++;
      this.changedDocument(uri, previous);
    } else {
      this.documents.set(uri, { text, version: 1, languageId, canonical: true });
      this.opened(uri);
    }
  }
  cancelStart() { this.preparation.abort(); }
  async stop(pause = false) {
    this.cancelStart();
    if (pause) this.paused = true;
    if (this.starting) await this.starting.catch(() => {});
    const child = this.child;
    if (!child) {
      this.phase = "stopped";
      this.emit("oxbit/serverState", { state: "stopped", paused: this.paused });
      return;
    }
    try {
      await Promise.race([
        this.rawRequest("shutdown", null),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      this.send({ jsonrpc: "2.0", method: "exit" });
    } catch {
      /* Shutdown continues after a failed server response. */
    }
    killProcess(child);
    this.failed(new RpcError("LSP_STOPPED", "Language server stopped"));
  }
  async restart() {
    await this.stop();
    return this.start(true);
  }
}
