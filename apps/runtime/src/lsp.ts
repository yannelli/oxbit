import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { RpcError } from "@zapp/protocol";
import { WorkspaceFiles } from "./filesystem.js";
import { killProcess } from "./processes.js";
interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
}
export class LanguageServer {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private starting?: Promise<unknown>;
  private capabilities: unknown;
  private commandQueue: Promise<unknown> = Promise.resolve();
  private applyEdit?: (edit:unknown,label?:string)=>Promise<{applied:boolean;failureReason?:string}>;
  private documents = new Map<
    string,
    { text: string; version: number; languageId: string; canonical: boolean }
  >();
  constructor(
    private files: WorkspaceFiles,
    private emit: (method: string, params: any) => void,
  ) {}
  versions() {
    return Object.fromEntries(
      [...this.documents].map(([uri, doc]) => [uri, doc.version]),
    );
  }
  uri(relative: string) {
    return pathToFileURL(path.join(this.files.root, relative)).href;
  }
  async validate(value: unknown): Promise<void> {
    if (Array.isArray(value)) {
      for (const child of value) await this.validate(child);
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
          if (!this.files.inside(full))
            throw new RpcError(
              "PATH_DENIED",
              "Language service URI leaves workspace",
            );
          await this.files.resolve(path.relative(this.files.root, full), true);
        } else await this.validate(child);
      }
    }
  }
  private send(message: unknown) {
    if (!this.child || !this.child.stdin.writable)
      throw new RpcError("LSP_UNAVAILABLE", "Language server is stopped");
    const body = JSON.stringify(message);
    this.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }
  private rawRequest(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted)
      return Promise.reject(
        new RpcError("CANCELLED", "Language request was cancelled"),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        try {
          this.send({
            jsonrpc: "2.0",
            method: "$/cancelRequest",
            params: { id },
          });
        } catch {
          /* Cancellation races with server shutdown. */
        }
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(new RpcError("CANCELLED", "Language request was cancelled"));
        }
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        reject(new RpcError("LSP_TIMEOUT", `${method} exceeded 30 seconds`));
      }, 30000);
      timer.unref();
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async start(): Promise<any> {
    if (this.starting) return this.starting;
    if (this.child && this.capabilities)
      return { capabilities: this.capabilities, rootUri: this.uri("") };
    this.starting = this.launch();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async launch() {
    const command = process.env.ZAPP_LSP_COMMAND || process.execPath;
    const args = process.env.ZAPP_LSP_COMMAND
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
        ];
    this.child = spawn(command, args, {
      cwd: this.files.root,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = Buffer.alloc(0);
    this.child.stdout.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 16 * 1024 * 1024) {
        void this.stop();
        return;
      }
      while (true) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = this.buffer.subarray(0, end).toString();
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          void this.stop();
          return;
        }
        const size = Number(match[1]);
        if (size > 16 * 1024 * 1024) {
          void this.stop();
          return;
        }
        if (this.buffer.length < end + 4 + size) return;
        const body = this.buffer.subarray(end + 4, end + 4 + size);
        this.buffer = this.buffer.subarray(end + 4 + size);
        try {
          this.receive(JSON.parse(body.toString()));
        } catch (error) {
          this.emit("window/logMessage", { type: 1, message: String(error) });
        }
      }
    });
    this.child.stderr.on("data", (data: Buffer) =>
      this.emit("window/logMessage", {
        type: 4,
        message: data.toString().slice(0, 16000),
      }),
    );
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
      rootUri: this.uri(""),
      workspaceFolders: [
        { uri: this.uri(""), name: path.basename(this.files.root) },
      ],
      capabilities: {
        workspace: {
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
          configuration: true,
        },
        textDocument: {
          synchronization: { didSave: true },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: { versionSupport: true },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["quickfix", "refactor", "source.organizeImports"],
              },
            },
          },
        },
      },
      clientInfo: { name: "Zapp", version: "0.1.0" },
    });
    this.capabilities = initialized.capabilities;
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    for (const [uri, doc] of this.documents)
      this.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: doc.languageId,
            version: doc.version,
            text: doc.text,
          },
        },
      });
    this.emit("zapp/serverState", { state: "running" });
    return { capabilities: this.capabilities, rootUri: this.uri("") };
  }
  private receive(message: any) {
    if (message.id !== undefined && message.method) {
      if (message.method === "workspace/applyEdit") {
        const child = this.child;
        void (async () => { await this.validate(message.params?.edit); return this.applyEdit ? await this.applyEdit(message.params.edit,message.params.label) : {applied:false,failureReason:"No initiating document client is available"}; })().catch(error=>({applied:false,failureReason:String(error)})).then(result=>{ if(this.child===child) this.send({jsonrpc:"2.0",id:message.id,result}); });
        return;
      }
      if (message.method === "workspace/configuration")
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: (message.params?.items ?? []).map(() => ({})),
        });
      else if (
        message.method === "window/workDoneProgress/create" ||
        message.method === "client/registerCapability"
      )
        this.send({ jsonrpc: "2.0", id: message.id, result: null });
      else this.send({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:`Unsupported server request ${message.method}`}});
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (message.error)
        pending.reject(
          new RpcError("LSP_ERROR", message.error.message, {
            code: message.error.code,
            data: message.error.data,
          }),
        );
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit(message.method, message.params);
  }
  private failed(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
    this.child = undefined;
    this.capabilities = undefined;
    this.emit("zapp/serverState", { state: "stopped", error: error.message });
  }
  async request(method: string, params: unknown, signal?: AbortSignal, applyEdit?: (edit:unknown,label?:string)=>Promise<{applied:boolean;failureReason?:string}>) {
    await this.validate(params); await this.start();
    if (method !== "workspace/executeCommand") return this.rawRequest(method,params,signal);
    const operation = this.commandQueue.catch(()=>{}).then(async()=>{
      let rejected:string|undefined;
      this.applyEdit = async(edit,label)=>{ let result:{applied:boolean;failureReason?:string}; try { result=applyEdit ? await applyEdit(edit,label) : {applied:false,failureReason:"No initiating document client is available"}; } catch(error) {result={applied:false,failureReason:String(error)};} if (!result.applied) rejected=result.failureReason??"Workspace edit was rejected"; return result; };
      try { const result=await this.rawRequest(method,params,signal); if (rejected) throw new RpcError("LSP_EDIT_REJECTED",rejected); return result; } finally { this.applyEdit=undefined; }
    });
    this.commandQueue=operation; return operation;
  }
  async notify(method: string, params: any) {
    await this.validate(params);
    if (
      ![
        "textDocument/didOpen",
        "textDocument/didChange",
        "textDocument/didClose",
        "textDocument/didSave",
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
    if (method === "textDocument/didOpen") {
      if (existing) return;
      this.documents.set(uri, {
        text: params.textDocument.text,
        version: params.textDocument.version,
        languageId: params.textDocument.languageId,
        canonical: false,
      });
    }
    if (method === "textDocument/didChange") {
      if (!existing)
        throw new RpcError("NOT_OPEN", "Language document is not open");
      if (params.textDocument.version <= existing.version) return;
      for (const change of params.contentChanges ?? []) {
        if (change.range) {
          const lines = existing.text.split("\n");
          const offset = (p: { line: number; character: number }) =>
            lines
              .slice(0, p.line)
              .reduce((n: number, line: string) => n + line.length + 1, 0);
          const start =
              offset(change.range.start) + change.range.start.character,
            end = offset(change.range.end) + change.range.end.character;
          existing.text =
            existing.text.slice(0, start) +
            change.text +
            existing.text.slice(end);
        } else existing.text = change.text;
      }
      existing.version = params.textDocument.version;
    }
    if (method === "textDocument/didClose") this.documents.delete(uri);
    const running = !!this.capabilities;
    await this.start();
    if (running || method !== "textDocument/didOpen")
      this.send({ jsonrpc: "2.0", method, params });
  }
  closeCanonical(relative:string) { const uri=this.uri(relative),doc=this.documents.get(uri);if(!doc?.canonical)return;this.documents.delete(uri);if(this.capabilities)this.send({jsonrpc:"2.0",method:"textDocument/didClose",params:{textDocument:{uri}}}); }
  canonical(relative: string, text: string) {
    if (!/\.(?:[cm]?tsx?|[cm]?jsx?|json)$/.test(relative)) return;
    const uri = this.uri(relative),
      existing = this.documents.get(uri),
      languageId = /\.tsx$/.test(relative)
        ? "typescriptreact"
        : /\.jsx$/.test(relative)
          ? "javascriptreact"
          : /\.[cm]?js$/.test(relative)
            ? "javascript"
            : /\.json$/.test(relative) ? "json" : "typescript";
    if (existing) {
      existing.canonical = true;
      if (existing.text === text) return;
      existing.text = text;
      existing.version++;
      if (this.capabilities)
        this.send({
          jsonrpc: "2.0",
          method: "textDocument/didChange",
          params: {
            textDocument: { uri, version: existing.version },
            contentChanges: [{ text }],
          },
        });
    } else {
      const doc = { text, version: 1, languageId, canonical: true };
      this.documents.set(uri, doc);
      if (this.capabilities)
        this.send({
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: { textDocument: { uri, version: 1, languageId, text } },
        });
    }
  }
  async stop() {
    const child = this.child;
    if (!child) return;
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
    return this.start();
  }
}
