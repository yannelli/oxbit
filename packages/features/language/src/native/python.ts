import { initSync, PositionEncoding, Workspace, type Diagnostic as RuffDiagnostic } from "@astral-sh/ruff-wasm-web";
import type { NativeFileHost, WorkspaceFiles } from "./files.js";
import type { NativeService } from "./server.js";

declare const __oxbitSetTimer: (callback: () => void, milliseconds: number) => number;
declare const __oxbitClearTimer: (id: number) => void;
declare const __oxbitNow: () => number;
declare const __oxbitLog: (level: string, message: string) => void;
interface WorkerPort { deliver(message: unknown): void; output?: (message: unknown) => void }
/** `worker` evaluates `source` and then a bundled script in a child context on the same JavaScript VM and returns its global object. */
export type PythonHost = NativeFileHost & { worker?(source: string, name: string): { __oxbitWorker?: WorkerPort } | null | undefined };

interface RuffSettings { "line-length"?: number; lint: { select?: string[]; ignore?: string[]; "extend-select"?: string[] } }
const defaultSelect = ["E", "F", "W"];

/** Reads `line-length` and lint `select`/`ignore`/`extend-select` from `.ruff.toml`, `ruff.toml`, or `[tool.ruff]` in pyproject.toml. */
export function ruffSettings(files: WorkspaceFiles): RuffSettings {
  for (const [name, prefix] of [[".ruff.toml", ""], ["ruff.toml", ""], ["pyproject.toml", "tool.ruff"]]) {
    const text = files.readFile(files.root + "/" + name);
    if (text === undefined || prefix && !/^\s*\[tool\.ruff[\].]/m.test(text)) continue;
    const settings: RuffSettings = { lint: {} };
    const lines = text.split(/\r?\n/);
    let table = "";
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].replace(/#.*$/, "").trim();
      if (line.startsWith("[")) { table = /^\[([^[\]]+)\]$/.exec(line)?.[1].trim() ?? ""; continue; }
      const pair = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
      const lint = table === (prefix ? prefix + ".lint" : "lint");
      if (!pair || table !== prefix && !lint) continue;
      let value = pair[2];
      while (value.startsWith("[") && !value.includes("]") && index + 1 < lines.length) value += lines[++index].replace(/#.*$/, "");
      if (pair[1] === "line-length" && !lint && /^\d+$/.test(value)) settings["line-length"] = Number(value);
      if (pair[1] === "select" || pair[1] === "ignore" || pair[1] === "extend-select") settings.lint[pair[1]] = [...value.matchAll(/["']([^"']*)["']/g)].map(match => match[1]);
    }
    return settings;
  }
  return { lint: {} };
}

export function ruffDiagnostic(item: RuffDiagnostic) {
  const position = (location: { row: number; column: number }) => ({ line: location.row - 1, character: location.column - 1 });
  return {
    range: { start: position(item.start_location), end: position(item.end_location) },
    severity: !item.code || item.code === "invalid-syntax" ? 1 : 2,
    ...(item.code ? { code: item.code } : {}),
    source: "Ruff", message: item.message,
    ...(item.tags.length ? { tags: item.tags.map(tag => tag === "unnecessary" ? 1 : 2) } : {}),
    ...(item.fix ? { data: { title: item.fix.message, edits: item.fix.edits.map(edit => ({ range: { start: position(edit.location), end: position(edit.end_location) }, newText: edit.content ?? "" })) } } : {}),
  };
}

/** Installs the Web Worker globals that pyright.worker.js expects. Serialized with `toString`, so it reads only globals. */
function workerScope(name: string) {
  const scope = globalThis as any;
  scope.self = scope;
  scope.name = name;
  if (typeof scope.setTimeout !== "function") {
    scope.setTimeout = (callback: (...args: unknown[]) => void, milliseconds = 0, ...args: unknown[]) => __oxbitSetTimer(() => callback(...args), Number(milliseconds) || 0);
    scope.clearTimeout = (id?: number) => { if (id !== undefined) __oxbitClearTimer(id); };
    scope.setInterval = (callback: (...args: unknown[]) => void, milliseconds = 0, ...args: unknown[]) => {
      const handle = { id: 0 };
      const tick = () => { handle.id = __oxbitSetTimer(tick, Number(milliseconds) || 0); callback(...args); };
      handle.id = __oxbitSetTimer(tick, Number(milliseconds) || 0);
      return handle;
    };
    scope.clearInterval = (handle?: { id: number }) => { if (handle) __oxbitClearTimer(handle.id); };
    scope.setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) => scope.setTimeout(callback, 0, ...args);
    scope.clearImmediate = scope.clearTimeout;
  }
  scope.queueMicrotask ??= (callback: () => void) => { void Promise.resolve().then(callback); };
  scope.performance ??= { now: () => __oxbitNow() };
  const log = (level: string) => (...values: unknown[]) => __oxbitLog(level, values.map(String).join(" "));
  scope.console ??= { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: () => {}, trace: () => {} };
  scope.TextEncoder ??= class {
    encoding = "utf-8";
    encode(text = "") { const binary = unescape(encodeURIComponent(text)), bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index); return bytes; }
  };
  scope.TextDecoder ??= class {
    encoding = "utf-8";
    decode(input?: ArrayBuffer | ArrayBufferView) {
      const bytes = !input ? new Uint8Array(0) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      try { return decodeURIComponent(escape(binary)); } catch { return binary; }
    }
  };
  type Listener = (event: { data: unknown }) => void;
  class Port {
    readonly oxbitPort = true;
    other?: Port;
    onmessage: Listener | null = null;
    listeners: Listener[] = [];
    static [Symbol.hasInstance](value: any) { return Boolean(value?.oxbitPort); }
    postMessage(data: unknown) { const other = this.other!; scope.setTimeout(() => { other.onmessage?.({ data }); for (const listener of [...other.listeners]) listener({ data }); }, 0); }
    addEventListener(type: string, listener: Listener) { if (type === "message") this.listeners.push(listener); }
    removeEventListener(type: string, listener: Listener) { this.listeners = this.listeners.filter(item => item !== listener); }
    start() {}
    close() {}
  }
  scope.MessagePort = Port;
  scope.MessageChannel = class { port1 = new Port(); port2 = new Port(); constructor() { this.port1.other = this.port2; this.port2.other = this.port1; } };
  const listeners: Listener[] = [];
  scope.addEventListener = (type: string, listener: Listener) => { if (type === "message") listeners.push(listener); };
  scope.removeEventListener = () => {};
  scope.close = () => {};
  const port: WorkerPort = {
    deliver(message) {
      const data = typeof message === "string" ? JSON.parse(message) : message;
      scope.setTimeout(() => { for (const listener of listeners) listener({ data }); scope.onmessage?.({ data }); }, 0);
    },
  };
  scope.postMessage = (message: any) => port.output?.(message?.type === "browser/newWorker" ? message : JSON.stringify(message));
  scope.__oxbitWorker = port;
}

const pyrightRequests = new Set(["textDocument/completion", "completionItem/resolve", "textDocument/hover", "textDocument/definition", "textDocument/signatureHelp"]);

/** basedpyright's browser build in two child contexts: the language server and its background analysis worker. */
class Pyright {
  private foreground: WorkerPort;
  private next = 1;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private published = new Map<string, { version?: number; diagnostics: any[] }>();
  private waiters = new Set<() => void>();
  private synced = new Map<string, number>();
  private queue: Promise<unknown>;
  private warm = false;
  private disposed = false;
  constructor(private files: WorkspaceFiles, private host: Required<Pick<PythonHost, "worker">>) {
    this.foreground = this.spawn("foreground");
    this.foreground.output = message => typeof message === "string" ? this.receive(JSON.parse(message)) : this.spawn("background").deliver({ ...message as object, type: "browser/boot", mode: "background" });
    this.foreground.deliver({ type: "browser/boot", mode: "foreground" });
    this.queue = this.call("initialize", {
      processId: null, rootUri: files.rootUri, workspaceFolders: [{ uri: files.rootUri, name: files.root.split("/").at(-1) }],
      capabilities: {
        workspace: { configuration: true },
        textDocument: {
          publishDiagnostics: { versionSupport: true, tagSupport: { valueSet: [1, 2] } }, hover: { contentFormat: ["markdown", "plaintext"] },
          completion: { completionItem: { documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["documentation", "detail"] } } },
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], activeParameterSupport: true } },
        },
      },
      initializationOptions: { files: this.workspaceFiles() },
    }, 25_000).then(() => this.notify("initialized", {}));
  }
  private spawn(name: string): WorkerPort {
    const port = this.host.worker("(" + workerScope + ")(" + JSON.stringify(name) + ");", "pyright.worker.js")?.__oxbitWorker;
    if (!port) throw new Error("The bundled basedpyright worker is missing");
    return port;
  }
  /** Workspace Python sources and config files, because pyright reads only its in-memory file system. */
  private workspaceFiles() {
    const result: Record<string, string> = {};
    let paths: string[] = [], bytes = 0;
    try { paths = this.files.readDirectory(this.files.root, [".py", ".pyi"], ["**/.venv", "**/venv", "**/__pycache__", "**/site-packages", ".venv", "venv"], undefined, 16); } catch { /* fall back to open documents */ }
    for (const path of [this.files.root + "/pyproject.toml", this.files.root + "/pyrightconfig.json", ...paths]) {
      const text = this.files.readFile(path);
      if (text !== undefined && (bytes += text.length) < 8_000_000) result[path] = text;
    }
    return result;
  }
  private receive(message: any) {
    if (message.id !== undefined && message.method === undefined) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    } else if (message.method === "textDocument/publishDiagnostics") {
      this.published.set(message.params.uri, { version: message.params.version, diagnostics: message.params.diagnostics });
      for (const waiter of [...this.waiters]) waiter();
    } else if (message.id !== undefined) {
      const result = message.method === "workspace/configuration" ? message.params.items.map((item: any) => item.section === "basedpyright" ? { analysis: { typeCheckingMode: "standard" } } : null) : null;
      this.send({ jsonrpc: "2.0", id: message.id, result });
    }
  }
  private send(message: unknown) { if (!this.disposed) this.foreground.deliver(JSON.stringify(message)); }
  private notify(method: string, params: unknown) { this.send({ jsonrpc: "2.0", method, params }); }
  private call(method: string, params: unknown, timeout = 20_000) {
    const id = this.next++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`basedpyright did not answer ${method}`)); }, timeout);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  sync() {
    this.queue = this.queue.then(() => {
      for (const [path, document] of this.files.documents) {
        const uri = this.files.uri(path), version = this.synced.get(path);
        if (version === undefined) this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "python", version: document.version, text: document.text } });
        else if (version !== document.version) this.notify("textDocument/didChange", { textDocument: { uri, version: document.version }, contentChanges: [{ text: document.text }] });
        this.synced.set(path, document.version);
      }
      for (const path of this.synced.keys()) if (!this.files.documents.has(path)) {
        this.notify("textDocument/didClose", { textDocument: { uri: this.files.uri(path) } });
        this.synced.delete(path);
        this.published.delete(this.files.uri(path));
      }
    });
  }
  /** Waits for diagnostics of the current version; after the limit it returns the last published set. */
  async diagnostics(path: string) {
    const version = this.files.documents.get(path)?.version ?? 0, uri = this.files.uri(path);
    const current = () => { const item = this.published.get(uri); return item && (item.version ?? version) >= version ? item : undefined; };
    const deadline = Date.now() + (this.warm ? 5_000 : 15_000);
    await Promise.race([this.queue.catch(() => {}), new Promise(resolve => setTimeout(resolve, deadline - Date.now()))]);
    if (!current()) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(check); resolve(); };
      const check = () => { if (current()) finish(); };
      const timer = setTimeout(finish, Math.max(deadline - Date.now(), 0));
      this.waiters.add(check);
    });
    if (current()) this.warm = true;
    return (current() ?? this.published.get(uri))?.diagnostics.map(item => ({ ...item, source: "basedpyright" })) ?? [];
  }
  /** Waits for startup, bounded below the host's 30 s request limit. */
  async request(method: string, params: any) {
    const deadline = Date.now() + 25_000;
    await Promise.race([this.queue, new Promise((_, reject) => setTimeout(() => reject(new Error("basedpyright is still starting")), deadline - Date.now()))]);
    const result: any = await this.call(method, params, deadline - Date.now());
    if (method !== "textDocument/definition" || !result) return result;
    return (Array.isArray(result) ? result : [result]).filter(item => (item.uri ?? item.targetUri).startsWith(this.files.rootUri + "/"));
  }
  dispose() {
    this.disposed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error("basedpyright stopped"));
    this.pending.clear();
  }
}

export class PythonServer implements NativeService {
  readonly name = "Python (iOS)";
  readonly languages = ["python"];
  readonly capabilities: Record<string, unknown> = { documentFormattingProvider: true };
  private workspace?: Workspace;
  private settings = "";
  private pyright?: Pyright;
  private pyrightError?: string;
  constructor(private files: WorkspaceFiles, private host: PythonHost) {
    if (host.worker) Object.assign(this.capabilities, {
      completionProvider: { triggerCharacters: [".", "[", "\"", "'"], resolveProvider: true }, hoverProvider: true, definitionProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ",", ")"] },
    });
  }

  /** Compiles the Ruff module on first use so `initialize` does not wait for it. */
  private ruff(): Workspace {
    const settings = ruffSettings(this.files), key = JSON.stringify(settings);
    if (this.workspace && key === this.settings) return this.workspace;
    if (!this.workspace) {
      const module = this.host.resource?.("ruff_wasm_bg.wasm");
      if (!module) throw new Error("The bundled Ruff module is missing");
      initSync({ module: new Uint8Array(module) });
    }
    this.workspace?.free();
    const options = { ...settings, lint: { ...settings.lint, select: settings.lint.select ?? defaultSelect } };
    try { this.workspace = new Workspace(options, PositionEncoding.Utf16); }
    catch { this.workspace = new Workspace({ lint: { select: defaultSelect } }, PositionEncoding.Utf16); }
    this.settings = key;
    return this.workspace;
  }
  private text(path: string) {
    const document = this.files.documents.get(path);
    if (!document) throw new Error("Python language document is not open");
    return document.text;
  }
  async diagnostics(path: string) {
    const ruff = (this.ruff().check(this.text(path)) as RuffDiagnostic[]).map(ruffDiagnostic);
    return this.pyright ? [...ruff, ...await this.pyright.diagnostics(path)] : ruff;
  }
  request(method: string, params: any) {
    if (pyrightRequests.has(method) && this.host.worker) {
      if (!this.pyright) throw new Error(this.pyrightError ?? "basedpyright starts when a Python document opens");
      return this.pyright.request(method, params);
    }
    if (method === "textDocument/formatting") {
      const text = this.text(this.files.path(params.textDocument.uri)), formatted = this.ruff().format(text);
      if (formatted === text) return [];
      const lines = text.split("\n");
      return [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, newText: formatted }];
    }
    throw new Error(`Unsupported Python language request: ${method}`);
  }
  /** Starts basedpyright on the first open document so `initialize` returns without waiting for it. */
  changed() {
    if (!this.host.worker || this.pyrightError || !this.pyright && !this.files.documents.size) return;
    try { this.pyright ??= new Pyright(this.files, this.host as Required<Pick<PythonHost, "worker">>); }
    catch (error) { this.pyrightError = "basedpyright failed to start: " + (error instanceof Error ? error.message : String(error)); console.error(this.pyrightError); return; }
    this.pyright.sync();
  }
  dispose() { this.pyright?.dispose(); this.pyright = undefined; this.workspace?.free(); this.workspace = undefined; }
}
