import type { Extension, FeatureOptions, LanguageTransport } from "@oxbit/sdk";
import { native } from "./native.js";
import type { IosFileSystem } from "./filesystem.js";

export type IosLanguageServerKind = "typescript" | "json";
interface NativeMessage {
  result?: unknown;
  error?: { code: number; message: string };
  notifications: { method: string; params: unknown }[];
}

export class IosLanguageTransport implements LanguageTransport {
  private readonly sessionId = crypto.randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(method: string, params: any) => void>();
  private pending = new Set<(error: Error) => void>();
  private disposed = false;
  private initialized = false;

  constructor(private workspaceId: string, private kind: IosLanguageServerKind) {}

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("iOS language server is disposed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { this.pending.delete(fail); signal?.removeEventListener("abort", abort); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const abort = () => fail(signal?.reason ?? new DOMException("Language request cancelled", "AbortError"));
      this.pending.add(fail);
      signal?.addEventListener("abort", abort, { once: true });
      const operation = this.queue.then(async () => {
        if (this.disposed || !this.pending.has(fail)) return;
        const response = await native.lspMessage({ workspaceId: this.workspaceId, sessionId: this.sessionId, kind: this.kind, method, params: params ?? null });
        const message = JSON.parse(response.payload) as NativeMessage;
        if (this.disposed) return;
        for (const notification of message.notifications ?? [])
          for (const listener of this.listeners) listener(notification.method, notification.params);
        if (message.error) throw new Error(message.error.message);
        if (method === "initialize") this.initialized = true;
        if (this.pending.has(fail)) { cleanup(); resolve(message.result as T); }
      });
      this.queue = operation.catch(error => fail(error instanceof Error ? error : new Error(String(error))));
    });
  }

  notify(method: string, params: unknown): void {
    if (this.disposed || !this.initialized && method === "workspace/didChangeWatchedFiles") return;
    void this.request(method, params).catch(error => {
      if (!this.disposed)
        for (const listener of this.listeners) listener("oxbit/serverState", { state: "stopped", error: String(error) });
    });
  }

  onNotification(listener: (method: string, params: any) => void) {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    for (const reject of [...this.pending]) reject(new Error("iOS language server is disposed"));
    this.queue = this.queue.then(() => native.lspMessage({ workspaceId: this.workspaceId, sessionId: this.sessionId, kind: this.kind, method: "exit", params: null })).catch(() => {});
  }
}

const servers = [
  { kind: "typescript" as const, title: "TypeScript / JavaScript", languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
  { kind: "json" as const, title: "JSON / JSONC", languages: ["json", "jsonc"] },
];

export function createIosLanguageFeature(filesystem: IosFileSystem): Extension {
  return {
    manifest: {
      manifestVersion: 1, id: "oxbit.ios-language", name: "iOS Language Servers", version: "1.0.0", sdk: "^1.0.0",
      environments: ["browser", "embedded"], activation: ["*"], capabilities: ["lsp", "filesystem.read"],
    },
    activate(ctx) {
      const transports = new Set<IosLanguageTransport>();
      for (const server of servers) ctx.own(ctx.contributions.register({
        id: `language.ios.${server.kind}`, kind: "transport", title: server.title, priority: 100,
        data: {
          languages: server.languages,
          runtimeFallback: false,
          rootUri: "file://" + filesystem.root.split("/").map(encodeURIComponent).join("/"),
          createTransport: ({ signal }: { signal: AbortSignal }) => {
            const transport = new IosLanguageTransport(filesystem.id, server.kind);
            transports.add(transport);
            signal.addEventListener("abort", () => { transports.delete(transport); transport.dispose(); }, { once: true });
            return transport;
          },
        },
      }));
      const start = (path: string) => {
        const language = ctx.services.optional<{ servicesForPath(path: string): { transport: LanguageTransport; state: string; start(): Promise<void> }[] }>("language");
        for (const service of language?.servicesForPath(path) ?? [])
          if (service.transport instanceof IosLanguageTransport && service.state === "stopped") void service.start().catch(() => {});
      };
      const documents = ctx.services.get<FeatureOptions["documents"]>("documents");
      ctx.own(ctx.events.on("document.open", ({ path }) => start(path)));
      ctx.own(ctx.events.on("editor.active", () => {
        for (const document of documents.documents.values()) start(document.path);
      }));
      ctx.own(filesystem.watch(change => {
        const uri = "file://" + filesystem.root.split("/").map(encodeURIComponent).join("/") + "/" + change.path.split("/").map(encodeURIComponent).join("/");
        for (const transport of transports) transport.notify("workspace/didChangeWatchedFiles", {
          changes: [{ uri, type: change.kind === "created" ? 1 : change.kind === "deleted" ? 3 : 2 }],
        });
      }));
      ctx.subscribe(() => { for (const transport of transports) transport.dispose(); transports.clear(); });
      for (const document of documents.documents.values()) start(document.path);
    },
  };
}
