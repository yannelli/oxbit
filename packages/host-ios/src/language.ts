import { fileTypesToSelectors, validateFileTypes, type Extension, type FeatureOptions, type Json, type ConfigurationService, type LanguageTransport, type Persistence, type Setting } from "@oxbit/sdk";
import { native } from "./native.js";
import type { IosFileSystem } from "./filesystem.js";

export type IosLanguageServerKind = "typescript" | "json" | "yaml" | "dockerfile" | "shell" | "python";
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
  private sentSettings?: string;

  /** `settings` replaces the server settings in `initialize` and `workspace/didChangeConfiguration`. */
  constructor(private workspaceId: string, private kind: IosLanguageServerKind, private settings?: () => unknown) {}

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("iOS language server is disposed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.settings && method === "initialize") {
      const settings = this.settings();
      this.sentSettings = JSON.stringify(settings);
      params = { ...(params as object), initializationOptions: { ...(params as any)?.initializationOptions, settings } };
    }
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
    if (this.settings && method === "workspace/didChangeConfiguration") {
      const settings = this.settings(), text = JSON.stringify(settings);
      if (text === this.sentSettings) return;
      this.sentSettings = text;
      params = { settings };
    }
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

interface IosLanguageServer {
  id: string;
  kind: IosLanguageServerKind;
  name: string;
  description: string;
  fileTypes: string[];
  /** Settings section for schema download switches, matching the desktop `languageServers.<id>.settings` keys. */
  schemas?: "json" | "yaml";
}

export const iosLanguageServers: readonly IosLanguageServer[] = [
  { id: "typescript", kind: "typescript", name: "TypeScript / JavaScript", description: "TypeScript language service on the device: diagnostics, completion, hover, definitions, and formatting.", fileTypes: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
  { id: "json", kind: "json", name: "JSON", description: "JSON and JSONC validation, completion, and formatting with SchemaStore schemas.", fileTypes: ["json", "jsonc"], schemas: "json" },
  { id: "yaml", kind: "yaml", name: "YAML", description: "yaml-language-server on the device: validation against SchemaStore schemas such as GitHub workflows and Compose files.", fileTypes: ["yaml"], schemas: "yaml" },
  { id: "dockerfile", kind: "dockerfile", name: "Dockerfile", description: "Dockerfile diagnostics, completion, hover, and formatting.", fileTypes: ["dockerfile"] },
  { id: "shell", kind: "shell", name: "Bash / sh", description: "bash-language-server analysis with tree-sitter and shfmt formatting.", fileTypes: ["shellscript"] },
  { id: "zsh", kind: "shell", name: "Zsh", description: "Zsh files parsed with the bash grammar: symbols, completion, and syntax errors.", fileTypes: ["zsh"] },
  { id: "python", kind: "python", name: "Python", description: "Ruff diagnostics and formatting on the device.", fileTypes: ["python"] },
];

export const iosLanguageExtensionId = (server: Pick<IosLanguageServer, "id">) => `oxbit.language-${server.id}`;
export const fileTypesSetting = (id: string) => `languageServer.${id}.fileTypes`;
/** Saved state from the single extension that held every server before the per-server extensions. */
export const legacyIosLanguageExtensionId = "oxbit.ios-language";

/** A user who disabled the combined extension keeps every server disabled. */
export async function migrateIosLanguageState(persistence: Pick<Persistence, "get" | "set">): Promise<string[]> {
  const disabled = await persistence.get<string[]>("extension-disabled") ?? [];
  if (!disabled.includes(legacyIosLanguageExtensionId)) return disabled;
  const migrated = [...new Set([...disabled.filter(id => id !== legacyIosLanguageExtensionId), ...iosLanguageServers.map(iosLanguageExtensionId)])];
  await persistence.set("extension-disabled", migrated);
  return migrated;
}

function serverSettings(server: IosLanguageServer, configuration: ConfigurationService) {
  if (!server.schemas) return {};
  const section = server.schemas;
  const configured = (configuration.get<Record<string, { settings?: Record<string, any> }>>("languageServers") ?? {})[server.id]?.settings?.[section];
  const enabled = (key: "schemaDownload" | "schemaStore") =>
    configured?.[key]?.enable !== false && configuration.get<boolean>(`${section}.${key}.enable`) !== false;
  return { schemaDownload: enabled("schemaDownload"), schemaStore: enabled("schemaStore") };
}

function serverConfiguration(server: IosLanguageServer): Setting[] {
  const settings: Setting[] = [{
    id: fileTypesSetting(server.id), title: `${server.name}: File Types`, category: "Language Servers",
    description: "Language IDs (such as yaml) or glob patterns (such as **/*.conf or .github/**/*.yml) this server handles.",
    type: "array", items: "string", default: server.fileTypes, validate: validateFileTypes,
  }];
  if (server.schemas) settings.push(
    { id: `${server.schemas}.schemaStore.enable`, title: `${server.name}: SchemaStore Catalog`, category: "Language Servers", description: "Associate files with schemas from the SchemaStore catalog.", type: "boolean", default: true },
    { id: `${server.schemas}.schemaDownload.enable`, title: `${server.name}: Download Schemas`, category: "Language Servers", description: "Download schemas over HTTPS and cache them for 24 hours. When off, cached and bundled schemas are used.", type: "boolean", default: true },
  );
  return settings;
}

export function createIosLanguageFeatures(filesystem: IosFileSystem): Extension[] {
  return iosLanguageServers.map(server => createIosLanguageFeature(filesystem, server));
}

export function createIosLanguageFeature(filesystem: IosFileSystem, server: IosLanguageServer = iosLanguageServers[0]!): Extension {
  const id = iosLanguageExtensionId(server);
  const rootUri = "file://" + filesystem.root.split("/").map(encodeURIComponent).join("/");
  return {
    manifest: {
      manifestVersion: 1, id, name: `${server.name} Language Server`, description: server.description, version: "1.0.0", sdk: "^1.0.0",
      environments: ["browser", "embedded"], activation: ["*"], capabilities: ["lsp", "filesystem.read"],
      configuration: serverConfiguration(server),
    },
    activate(ctx) {
      const transports = new Set<IosLanguageTransport>();
      const fileTypes = () => ctx.configuration.get<Json>(fileTypesSetting(server.id)) as string[];
      let registered = JSON.stringify(fileTypes());
      let contribution: { dispose(): void } | undefined;
      const register = () => {
        contribution?.dispose();
        contribution = ctx.contributions.register({
          id: `language.ios.${server.id}`, kind: "transport", title: server.name, priority: 100,
          data: {
            languages: server.fileTypes,
            selectors: fileTypesToSelectors(fileTypes()),
            runtimeFallback: false,
            rootUri,
            createTransport: ({ signal }: { signal: AbortSignal }) => {
              const transport = new IosLanguageTransport(filesystem.id, server.kind, () => serverSettings(server, ctx.configuration));
              transports.add(transport);
              signal.addEventListener("abort", () => { transports.delete(transport); transport.dispose(); }, { once: true });
              return transport;
            },
          },
        });
      };
      register();
      ctx.subscribe(() => contribution?.dispose());
      const start = (path: string) => {
        const language = ctx.services.optional<{ servicesForPath(path: string): { transport: LanguageTransport; state: string; start(): Promise<void> }[] }>("language");
        for (const service of language?.servicesForPath(path) ?? [])
          if (service.transport instanceof IosLanguageTransport && service.state === "stopped") void service.start().catch(() => {});
      };
      const documents = ctx.services.get<FeatureOptions["documents"]>("documents");
      const startAll = () => { for (const document of documents.documents.values()) start(document.path); };
      ctx.own(ctx.events.on("document.open", ({ path }) => start(path)));
      ctx.own(ctx.events.on("editor.active", startAll));
      ctx.subscribe(ctx.configuration.subscribe(() => {
        const next = JSON.stringify(fileTypes());
        if (next === registered) return;
        registered = next;
        register();
        startAll();
      }));
      ctx.own(filesystem.watch(change => {
        const uri = rootUri + "/" + change.path.split("/").map(encodeURIComponent).join("/");
        for (const transport of transports) transport.notify("workspace/didChangeWatchedFiles", {
          changes: [{ uri, type: change.kind === "created" ? 1 : change.kind === "deleted" ? 3 : 2 }],
        });
      }));
      ctx.subscribe(() => { for (const transport of transports) transport.dispose(); transports.clear(); });
      ctx.events.on("extension.change", ({ id: changed, state }) => {
        if (changed === id && state === "active") startAll();
      });
    },
  };
}
