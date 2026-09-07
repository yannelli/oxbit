import type {
  RpcClient,
  FileSystem,
  FileSnapshot,
  FileEntry,
  WriteOptions,
  FileChange,
  Disposable,
} from "@zapp/sdk";
import { RpcError, MAX_MESSAGE_BYTES, MAX_BUFFER_BYTES, operationMethods, type ServerMessage } from "@zapp/protocol";
type Pending = {
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
  method: string;
};
export class RuntimeClient implements RpcClient {
  private socket?: WebSocket;
  private token?: string;
  private pending = new Map<string, Pending>();
  private listeners = new Map<string, Set<(value: any) => void>>();
  private retry?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private stopped = false;
  private uncertain = new Map<string, string>();
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveringOperations = false;
  private opening?: Promise<void>;
  connected = false;
  session?: {
    token: string;
    workspaceId: string;
    capabilities: string[];
    trusted: boolean;
    owner: boolean;
    workspaceKey?: string;
    workspaceName?: string;
  };
  readonly url: string;
  constructor(
    url = globalThis.location?.origin ?? "http://localhost:9277",
    public workspaceId = "default",
  ) {
    this.url = url.replace(/\/$/, "");
    this.token =
      globalThis.sessionStorage?.getItem("zapp.runtime.token:" + this.url) ??
      undefined;
  }
  async pair(code: string) {
    if (code.startsWith("grant:")) {
      this.token = code.slice(6);
      globalThis.sessionStorage?.setItem(
        "zapp.runtime.token:" + this.url,
        this.token,
      );
      await this.connect();
      return this.session;
    }
    const r = await fetch(this.url + "/api/pair", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await r.json();
    if (!r.ok)
      throw new Error(data.error?.message ?? data.error ?? "Pairing failed");
    this.session = data;
    this.token = data.token;
    globalThis.sessionStorage?.setItem(
      "zapp.runtime.token:" + this.url,
      data.token,
    );
    return data;
  }
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.opening) return this.opening;
    this.stopped = false;
    clearTimeout(this.retry);
    this.emit("connection.change", { state: "connecting" });
    this.opening = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url.replace(/^http/, "ws") + "/ws");
      this.socket = ws;
      let authenticated = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Runtime connection timed out"));
      }, 10000);
      ws.onopen = () => {
        void this.sendRequest<Record<string, unknown>>(
          "auth.authenticate",
          { token: this.token },
          {},
        ).then(
          (session) => {
            if (this.socket !== ws) { reject(new Error("Connection was replaced")); return; }
            authenticated = true;
            clearTimeout(timer);
            this.connected = true;
            this.retries = 0;
            this.session = {
              token: this.token ?? "",
              workspaceId: String(session.workspaceId ?? this.workspaceId),
              capabilities: Array.isArray(session.capabilities)
                ? session.capabilities.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
              trusted: session.trusted === true,
              owner: session.owner === true,
              workspaceKey:
                typeof session.workspaceKey === "string"
                  ? session.workspaceKey
                  : undefined,
              workspaceName:
                typeof session.workspaceName === "string"
                  ? session.workspaceName
                  : undefined,
            };
            this.emit("connection.change", { state: "connected" });
            resolve();
            void this.recoverOperations();
          },
          (error) => {
            clearTimeout(timer);
            this.stopped = true;
            reject(error);
            ws.close();
          },
        );
      };
      ws.onmessage = (event) => {
        if (this.socket !== ws) return;
        try {
          const m = JSON.parse(String(event.data)) as ServerMessage;
          if (m.v !== 1 || !["response", "event"].includes(m.type)) throw new Error("Invalid runtime response");
          if (m.type === "response") {
            const p = this.pending.get(m.id);
            if (p) {
              this.pending.delete(m.id);
              p.cleanup();
              if (m.error)
                p.reject(
                  new RpcError(m.error.code, m.error.message, m.error.data),
                );
              else p.resolve(m.result);
            }
          } else if (m.type === "event") {
            if (m.event === "workspace.trust" && this.session) this.session.trusted = m.params.trusted === true;
            this.emit(m.event, {
              ...m.params,
              ...(m.seq === undefined ? {} : { seq: m.seq }),
            });
          }
        } catch (error) {
          this.emit("connection.error", { error: String(error) });
        }
      };
      ws.onerror = () => {
        if (!authenticated) {
          clearTimeout(timer);
          reject(new Error("Cannot connect to runtime"));
        }
      };
      ws.onclose = (event) => {
        clearTimeout(timer);
        if (this.socket !== ws) return;
        if (event.code === 4003) this.stopped = true;
        this.connected = false;
        this.opening = undefined;
        for (const [id, p] of this.pending) {
          if ((operationMethods as readonly string[]).includes(p.method)) this.uncertain.set(id, p.method);
          p.cleanup();
          p.reject(
            new RpcError(
              "CONNECTION_LOST",
              `Connection lost; inspect operation.status for ${id}`,
              { id, method: p.method },
            ),
          );
        }
        this.pending.clear();
        this.emit("connection.change", {
          state: this.stopped ? "disconnected" : "reconnecting",
        });
        if (!authenticated) reject(new Error("Runtime connection closed"));
        if (!this.stopped) {
          this.retry = setTimeout(
            () => {
              void this.connect().catch(() => {});
            },
            Math.min(1000 * 2 ** this.retries++, 15000),
          );
        }
      };
    }).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }
  async trust(trusted = true) {
    const result = await this.request<{trusted:boolean}>("workspace.trust", { trusted });
    if (this.session) this.session.trusted = result.trusted;
    return result;
  }
  private async recoverOperations() {
    if (this.recoveringOperations) return;
    this.recoveringOperations = true;
    clearTimeout(this.recoveryTimer);
    try {
      for (const [id, method] of this.uncertain) {
        if (!this.connected) return;
        try { const operation = await this.request<any>("operation.status", {id}); this.emit("operation.recovered", {id, method, ...operation}); if (operation.status !== "running") this.uncertain.delete(id); } catch { return; }
      }
    } finally {
      this.recoveringOperations = false;
      if (this.connected && this.uncertain.size) this.recoveryTimer=setTimeout(()=>void this.recoverOperations(),2000);
    }
  }
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; id?: string } = {},
  ): Promise<T> {
    if (!this.connected)
      return Promise.reject(
        new RpcError("OFFLINE", "Connect to the runtime first"),
      );
    return this.sendRequest(method, params, options);
  }
  private sendRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal; id?: string },
  ): Promise<T> {
    const id = options.id ?? crypto.randomUUID();
    if (options.signal?.aborted)
      return Promise.reject(
        options.signal.reason ?? new DOMException("Cancelled", "AbortError"),
      );
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) { reject(new RpcError("OFFLINE", "Runtime socket is closed")); return; }
      if (this.pending.size >= 64 || this.socket.bufferedAmount > MAX_BUFFER_BYTES) { reject(new RpcError("BUSY", "Runtime request queue is full")); return; }
      const serialized = JSON.stringify({v:1,type:"request",id,method,params:{workspaceId:this.workspaceId,...params}});
      if (new TextEncoder().encode(serialized).byteLength > MAX_MESSAGE_BYTES) { reject(new RpcError("TOO_LARGE", "Runtime request exceeds 2 MiB")); return; }
      if (this.pending.has(id)) {
        reject(new Error("Duplicate pending request ID"));
        return;
      }
      const abort = () => {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ v: 1, type: "cancel", id }));
        this.pending.delete(id);
        cleanup();
        reject(
          options.signal?.reason ?? new DOMException("Cancelled", "AbortError"),
        );
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if ((operationMethods as readonly string[]).includes(method)) this.uncertain.set(id, method);
        cleanup();
        reject(
          new RpcError(
            "TIMEOUT",
            `Operation ${id} timed out; inspect its status`,
            { id },
          ),
        );
      }, 120000);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup, method });
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.socket.send(serialized);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }
  ack(stream: string, seq: number) {
    if (this.connected)
      this.socket?.send(JSON.stringify({ v: 1, type: "ack", stream, seq }));
  }
  subscribe(event: string, listener: (value: any) => void) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
  private emit(event: string, value: any) {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(value);
      } catch {
        /* A subscriber must not interrupt message dispatch. */
      }
    }
  }
  disconnect() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.recoveryTimer);
    this.socket?.close();
    this.connected = false;
    for (const [id, pending] of this.pending) { if ((operationMethods as readonly string[]).includes(pending.method)) this.uncertain.set(id, pending.method); pending.cleanup(); pending.reject(new RpcError("CONNECTION_LOST", "Runtime disconnected", {id,method:pending.method})); }
    this.pending.clear();
  }
  dispose() {
    this.disconnect();
    this.listeners.clear();
  }
}
export class RuntimeFileSystem implements FileSystem {
  readonly id: string;
  beforeWrite?: () => Promise<void>;
  private watcherCount = 0;
  readonly shared = new Map<
    string,
    {
      update: string;
      revision: string;
      savedText: string;
      awareness?: string;
      conflict?: boolean;
    }
  >();
  constructor(public readonly client: RpcClient) {
    this.id =
      "runtime:" +
      ("url" in client ? client.url : "") +
      ":" +
      ((client as RuntimeClient).session?.workspaceKey ??
        ("workspaceId" in client ? client.workspaceId : "default"));
  }
  list(path = "") {
    return this.client.request<FileEntry[]>("fs.list", { path });
  }
  readDisk(path: string) { return this.client.request<FileSnapshot>("fs.read", {path}); }
  async read(path: string) {
    const snapshot = await this.client.request<FileSnapshot>("fs.read", {
      path,
    });
    try {
      const room = await this.client.request<{
        update: string;
        revision: string;
        savedText: string;
        awareness?: string;
        conflict?: boolean;
      }>("collab.join", { path });
      this.shared.set(path, room);
      return {
        ...snapshot,
        text: room.savedText,
        sharedUpdate: room.update,
        revision: room.revision,
      };
    } catch (error) {
      if (
        error instanceof RpcError &&
        ["FORBIDDEN", "CAPABILITY_DENIED", "PERMISSION_DENIED"].includes(
          error.code,
        )
      )
        return snapshot;
      throw error;
    }
  }
  async write(path: string, text: string, options: WriteOptions) {
    if (this.shared.has(path) && !this.beforeWrite) throw new RpcError("COLLAB_UNAVAILABLE", "Enable collaboration to synchronize and save this shared document");
    await this.beforeWrite?.();
    return this.client.request<FileSnapshot>(
      this.shared.has(path) ? "collab.save" : "fs.write",
      { path, text, ...options },
    );
  }
  async mkdir(path: string) {
    await this.client.request("fs.mkdir", { path });
  }
  async rename(path: string, to: string) {
    await this.client.request("fs.rename", { path, to });
    this.shared.delete(path);
  }
  async delete(path: string) {
    await this.client.request("fs.delete", { path });
    this.shared.delete(path);
  }
  watch(listener: (event: FileChange) => void): Disposable {
    this.watcherCount++;
    const off = this.client.subscribe("fs.change", listener);
    void this.client.request("fs.watch").catch(() => {});
    const reconnect = this.client.subscribe("connection.change", value => { if (value.state === "connected") void this.client.request("fs.watch").catch(() => {}); });
    let disposed = false;
    return { dispose: () => { if (disposed) return; disposed = true; off(); reconnect(); this.watcherCount--; if (!this.watcherCount && this.client.connected) void this.client.request("fs.unwatch").catch(() => {}); } };
  }
}
