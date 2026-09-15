import { ExternalSource, Hierarchy, WorkspaceSymbols, navigationTargets, type NavigationTarget } from "./navigation.js";
import { LanguageOverlays, semanticTypes, semanticModifiers } from "./overlays.js";
import { completionItems, completionTransactions } from "./completion.js";
import { documentationPopups, showDocumentation, showSignature } from "./popups.js";
import { logLinkExtensions } from "./log-links.js";
import { languages, languageForKernel, matchesFilePattern, lspGlobMatches, lspWatchPattern, textOffset, textPosition, incrementalChange, synchronization, effectiveCapabilities, lspCapabilityKeys, type LspRegistration, type LanguageServerSettings } from "@oxbit/sdk";
import { LocalLanguageTransport } from "./local.js";
import { translate as tr } from "@oxbit/ui";
import React, { useState, useEffect } from "react";
import {
  autocompletion,
  type CompletionContext,
  pickedCompletion,
} from "@codemirror/autocomplete";
import { hoverTooltip, EditorView, ViewPlugin } from "@codemirror/view";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { type Extension as CMExtension } from "@codemirror/state";
import type {
  Extension,
  FeatureOptions,
  LanguageTransport,
  DocumentEdit,
  ResourceEdit,
  LanguageTransportProvider,
  ProviderCodeAction,
  CompletionProvider,
} from "@oxbit/sdk";
import { LanguageProviders, documentLanguage } from "./providers.js";
import type { DocumentHandle } from "@oxbit/documents";
import { hoverDOM } from "./hover.js";
import { LanguageStatus } from "./status.js";
import { documentSymbols } from "./symbols.js";
import { ProjectIntelligenceView } from "./project.js";
export interface EditSnapshot {
  version?: number;
  revision: string;
  lspVersion?: number;
}
const capabilitiesByMethod = lspCapabilityKeys;
const supportedPath = (path: string) =>
  /\.(?:[cm]?tsx?|[cm]?jsx?|json)$/.test(path);
const abortError = () =>
  new DOMException("Language request cancelled", "AbortError");
export const offset = textOffset;
export const position = textPosition;
export class WorkerLanguageTransport implements LanguageTransport {
  private seq = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: unknown) => void;
      cleanup: () => void;
    }
  >();
  private listeners = new Set<(method: string, params: any) => void>();
  private incomingRequests = new Map<string | number, AbortController>();
  private serverRequest?: (method: string, params: any, signal?: AbortSignal) => Promise<unknown>;
  constructor(private worker: Worker) {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== undefined && m.method) {
        const controller = new AbortController();
        this.incomingRequests.get(m.id)?.abort(); this.incomingRequests.set(m.id, controller);
        const respond = (response: any) => { if (this.incomingRequests.get(m.id) === controller) { this.incomingRequests.delete(m.id); this.worker.postMessage({ jsonrpc: "2.0", id: m.id, ...response }); } };
        controller.signal.addEventListener("abort", () => respond({ error: { code: -32800, message: "Server request cancelled" } }), { once: true });
        void Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          if (!this.serverRequest) throw new Error(`Unsupported server request ${m.method}`);
          return this.serverRequest(m.method, m.params, controller.signal);
        }).then(result => respond({ result }), error => respond({ error: { code: -32601, message: String(error) } }));
      } else if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p.cleanup();
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        }
      } else if (m.method === "$/cancelRequest") this.incomingRequests.get(m.params?.id)?.abort();
      else for (const fn of this.listeners) fn(m.method, m.params);
    };
    worker.onerror = (e) => {
      for (const controller of this.incomingRequests.values()) controller.abort(); this.incomingRequests.clear();
      for (const p of this.pending.values()) {
        p.cleanup();
        p.reject(new Error(e.message));
      }
      this.pending.clear();
      for (const fn of this.listeners)
        fn("oxbit/serverState", { state: "stopped", error: e.message });
    };
  }
  request<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const cancel = (error: Error) => {
        this.notify("$/cancelRequest", { id });
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      const abort = () => cancel(abortError());
      const timer = setTimeout(
        () => cancel(new Error(method + " exceeded 30 seconds")),
        30000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      try {
        this.worker.postMessage({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }
  notify(method: string, params: unknown) {
    this.worker.postMessage({ jsonrpc: "2.0", method, params });
  }
  onNotification(fn: (method: string, params: any) => void) {
    this.listeners.add(fn);
    return {
      dispose: () => {
        this.listeners.delete(fn);
      },
    };
  }
  onRequest(handler: (method: string, params: any, signal?: AbortSignal) => Promise<unknown>) {
    this.serverRequest = handler;
    return { dispose: () => { if (this.serverRequest === handler) { this.serverRequest = undefined; for (const controller of this.incomingRequests.values()) controller.abort(); this.incomingRequests.clear(); } } };
  }
  dispose() {
    this.serverRequest = undefined;
    for (const controller of this.incomingRequests.values()) controller.abort(); this.incomingRequests.clear();
    this.worker.terminate();
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(new Error("Language transport disposed"));
    }
    this.pending.clear();
    this.listeners.clear();
  }
}
export class RuntimeLanguageTransport implements LanguageTransport {
  instanceId?: string;
  constructor(private o: FeatureOptions, readonly documentPath?: string, readonly definitionId?: string) {}
  get scope() { return this.instanceId ? { instanceId: this.instanceId } : {}; }
  async attach() {
    if (!this.documentPath) return;
    const language = documentLanguage(this.o, this.documentPath);
    const result = await this.o.runtime!.request<any>("lsp.attach", {
      path: this.documentPath, definitionId: this.definitionId,
      configuration: this.o.kernel.configuration.get<LanguageServerSettings>("languageServers", language) ?? {},
      associations: this.o.kernel.configuration.get("files.associations") ?? {},
    });
    this.instanceId = result.instanceId;
    return result;
  }
  async start(resume: boolean) {
    await this.attach();
    return this.o.runtime!.request<any>("lsp.start", { resume, ...this.scope });
  }
  async status() {
    if (this.documentPath) return this.attach();
    return this.o.runtime!.request<any>("lsp.status", this.scope);
  }
  request<T>(method: string, params: unknown, signal?: AbortSignal) {
    if (!this.o.runtime)
      return Promise.reject(new Error("Runtime unavailable"));
    return this.o.runtime.request<T>(
      "lsp.request",
      { method, params, ...this.scope },
      { signal },
    );
  }
  notify(method: string, params: unknown) {
    void this.o.runtime
      ?.request("lsp.notify", { method, params, ...this.scope })
      .catch((e) => this.o.workbench.notify(String(e), "error"));
  }
  onNotification(fn: (method: string, params: any) => void) {
    return {
      dispose:
        this.o.runtime?.subscribe("lsp.notification", (p) => {
          if (p.instanceId === this.instanceId) fn(p.method, p.params);
        }) ?? (() => {}),
    };
  }
  onRequest(handler: (method: string, params: any, signal?: AbortSignal) => Promise<unknown>) {
    return { dispose: this.o.runtime?.subscribe("lsp.notification", message => {
      if (message.instanceId !== this.instanceId || message.method !== "oxbit/serverRequest") return;
      const request = message.params;
      void handler(request.method, request.params).catch(() => null).then(result => this.o.runtime?.request("lsp.serverResponse", { ...this.scope, id: request.id, result })).catch(() => {});
    }) ?? (() => {}) };
  }
  dispose() {
    if (this.instanceId) void this.o.runtime?.request("lsp.detach", { ...this.scope, path: this.documentPath }).catch(() => {});
  }
}
export class LanguageService {
  capabilities: Record<string, any> = {};
  private registrations = new Map<string, LspRegistration>();
  private requestSubscription?: { dispose(): void };
  private fileWatchSubscription?: { dispose(): void };
  private syncedText = new Map<string, string>();
  effective(path = this.providerContext?.path ?? this.o.workbench.activePath()) {
    return effectiveCapabilities(this.capabilities, this.registrations.values(), path ? { path, language: documentLanguage(this.o, path) } : undefined);
  }
  rootUri = "";
  state = "unavailable";
  name = "TypeScript / JavaScript";
  error = "";
  private completionIncomplete = new Map<string, boolean>();
  private navigationHistory: { service: LanguageService; target: NavigationTarget }[] = [];
  private navigationIndex = -1;
  private navigationOrigin?: { service: LanguageService; target: NavigationTarget };
  private overlayProviderFingerprint = "";
  private extensionCache = new Map<string, CMExtension[]>();
  private overlays = new Map<string, LanguageOverlays>();
  private managedServices = new Map<string, LanguageService>();
  private laravelProjects = new Map<string, boolean>();
  private laravelLookups = new Set<string>();
  private laravelGeneration = 0;
  projectRootUri = "";
  installedVersion = "";
  output: string[] = [];
  private paused = false;
  private notificationSubscription?: { dispose(): void };
  private recreateTransport = false;
  private lspDiagnostics = new Map<string, any[]>();
  private publishedDiagnostics = new Map<string, string>();
  private providers?: LanguageProviders;
  private transports = new Map<
    string,
    {
      data: LanguageTransportProvider;
      service: LanguageService;
      controller: AbortController;
      unsubscribe: () => void;
    }
  >();
  transport: LanguageTransport;
  private listeners = new Set<() => void>();
  private views = new Map<string, Set<EditorView>>();
  private subscriptions: (() => void)[] = [];
  private starting?: Promise<void>;
  private disposed = false;
  private generation = 0;
  private activeRequests = new Set<AbortController>();
  private requestPaths = new Map<AbortController, string>();
  private synced = new Map<string, number>();
  private diagnosticVersions = new Map<string, number>();
  private syncQueue: Promise<void> = Promise.resolve();
  private commandSnapshots?: Map<string, EditSnapshot>;
  constructor(
    private o: FeatureOptions,
    transport?: LanguageTransport,
    private providerContext?: {
      owner: LanguageService;
      languages: string[];
      rootUri?: string;
      path?: string;
      createTransport?: () => LanguageTransport;
    },
  ) {
    this.transport =
      transport ??
      o.kernel.services.optional<LanguageTransport>("language.transport") ??
      new RuntimeLanguageTransport(o);
    if (!(this.transport instanceof RuntimeLanguageTransport)) this.state = "stopped";
    this.bindNotifications();
    this.subscriptions.push(o.kernel.configuration.subscribe(() => {
      for (const overlay of this.overlays.values()) overlay.refresh(true);
      if (this.state === "ready" && !(this.transport instanceof RuntimeLanguageTransport)) this.transport.notify("workspace/didChangeConfiguration", { settings: null });
    }));
    this.subscriptions.push(
      o.kernel.events.on("document.open", ({ path }) => {
        if (this.state === "ready")
          void this.syncDocument(path).catch((error) =>
            o.workbench.notify(String(error), "error"),
          );
      }).dispose,
    );
    this.subscriptions.push(
      o.kernel.events.on("document.change", ({ id }) => {
        const doc = [
          ...(o.documents.documents.values() as Iterable<DocumentHandle>),
        ].find((doc) => doc.id === id);
        if (doc && this.state === "ready")
          void this.syncDocument(doc.path).catch((error) =>
            o.workbench.notify(String(error), "error"),
          );
      }).dispose,
    );
    this.subscriptions.push(
      o.kernel.events.on("document.close", () => {
        for (const path of this.synced.keys())
          if (!o.documents.get(path)) {
            if (!this.shared(path) && (this.transport instanceof RuntimeLanguageTransport || synchronization(this.effective(path)).openClose))
              this.transport.notify("textDocument/didClose", {
                textDocument: { uri: this.uri(path) },
              });
            this.synced.delete(path);
            this.syncedText.delete(path);
            this.lspDiagnostics.delete(path);
          }
      }).dispose,
    );
    if (o.runtime && this.transport instanceof RuntimeLanguageTransport)
      this.subscriptions.push(
        o.runtime.subscribe("lsp.applyEdit", (params) => {
          if (params.instanceId !== (this.transport as RuntimeLanguageTransport).instanceId) return;
          void (async () => {
            let result: { applied: boolean; failureReason?: string };
            try {
              if (!this.commandSnapshots)
                throw new Error(
                  "No revision snapshot exists for this language command",
                );
              await this.applyWorkspaceEdit(params.edit, this.commandSnapshots);
              result = { applied: true };
            } catch (error) {
              result = { applied: false, failureReason: String(error) };
            }
            await o.runtime!.request("lsp.applyEditResult", {
              id: params.id,
              ...result,
            });
          })().catch((error) => o.workbench.notify(String(error), "error"));
        }),
      );
    if (o.runtime && this.transport instanceof RuntimeLanguageTransport)
      this.subscriptions.push(
        o.runtime.subscribe("connection.change", (params) => {
          if (params.state !== "connected") this.stopped("disconnected");
          else void this.refreshStatus();
        }),
      );
    if (!this.providerContext) {
      this.subscriptions.push(o.filesystem.watch(change => {
        if (change.path.split("/").at(-1) === "artisan") {
          this.laravelGeneration++; this.laravelProjects.clear(); this.laravelLookups.clear();
          for (const [key, service] of this.managedServices) if (service.transport instanceof RuntimeLanguageTransport && service.transport.definitionId === "laravel") { service.dispose(); this.managedServices.delete(key); }
          this.providersChanged();
        }
      }).dispose);
      this.providers = new LanguageProviders(o, () => this.providersChanged());
      this.subscriptions.push(
        o.kernel.contributions.subscribe(() => this.reconcileTransports()),
        o.kernel.events.on("editor.active", () => { this.updateContext(); this.changed(); }).dispose,
      );
      let configuration = JSON.stringify([o.kernel.configuration.get("languageServers"), o.kernel.configuration.get("files.associations")]);
      this.subscriptions.push(o.kernel.configuration.subscribe(() => {
        const next = JSON.stringify([o.kernel.configuration.get("languageServers"), o.kernel.configuration.get("files.associations")]);
        if (next === configuration) return;
        configuration = next;
        for (const service of this.managedServices.values()) service.dispose();
        this.managedServices.clear();
        this.providersChanged();
      }));
      this.subscriptions.push(o.kernel.events.on("document.close", () => {
        for (const [key, service] of this.managedServices) if (!o.documents.get(service.providerContext!.path!)) { service.dispose(); this.managedServices.delete(key); }
        this.providersChanged();
      }).dispose);
      this.providersChanged();
    }
  }
  private bindNotifications() {
    this.notificationSubscription?.dispose();
    this.requestSubscription?.dispose();
    this.requestSubscription = this.transport.onRequest?.(async (method, params) => {
      if (method === "client/registerCapability" || method === "client/unregisterCapability") {
        const adding = method === "client/registerCapability", items = adding ? params?.registrations : params?.unregisterations;
        if (!Array.isArray(items) || new Set(items.map((item: any) => item?.id)).size !== items.length || items.some((item: any) => typeof item?.id !== "string" || (adding ? !(capabilitiesByMethod[item.method] || /^textDocument\/(didOpen|didClose|didChange|didSave|willSave|willSaveWaitUntil)$/.test(item.method) || item.method === "workspace/didChangeConfiguration" || item.method === "workspace/didChangeWorkspaceFolders" || item.method === "workspace/didChangeWatchedFiles" && Array.isArray(item.registerOptions?.watchers) && item.registerOptions.watchers.every((watcher: any) => lspWatchPattern(watcher.globPattern, this.rootUri || this.providerContext?.rootUri || "file:///workspace") !== undefined && (watcher.kind === undefined || Number.isInteger(watcher.kind) && watcher.kind >= 1 && watcher.kind <= 7))) || this.registrations.has(item.id) : this.registrations.get(item.id)?.method !== item.method))) throw new Error("Unsupported or unknown capability registration");
        const previousSync = new Map([...this.synced.keys()].map(path => [path, synchronization(this.effective(path)).openClose]));
        for (const item of items) { if (adding) this.registrations.set(item.id, item); else this.registrations.delete(item.id); }
        for (const [path, wasOpen] of previousSync) {
          const isOpen = synchronization(this.effective(path)).openClose;
          if (!wasOpen && isOpen) { this.synced.delete(path); await this.syncDocument(path); }
          else if (wasOpen && !isOpen) this.transport.notify("textDocument/didClose", { textDocument: { uri: this.uri(path) } });
        }
        this.fileWatchSubscription?.dispose(); this.fileWatchSubscription = undefined;
        if ([...this.registrations.values()].some(item => item.method === "workspace/didChangeWatchedFiles")) this.fileWatchSubscription = this.o.filesystem.watch(change => {
          if (this.state !== "ready") return;
          const type = change.kind === "created" ? 1 : change.kind === "deleted" ? 3 : 2;
          if ([...this.registrations.values()].some(item => item.method === "workspace/didChangeWatchedFiles" && item.registerOptions.watchers.some((watcher: any) => ((watcher.kind ?? 7) & (1 << (type - 1))) && lspGlobMatches(lspWatchPattern(watcher.globPattern, this.rootUri || this.providerContext?.rootUri || "file:///workspace") ?? "", change.path)))) this.transport.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: this.uri(change.path), type }] });
        });
        this.updateContext(); this.providerContext?.owner.updateContext(); this.changed(); return null;
      }
      if (["workspace/semanticTokens/refresh", "workspace/inlayHint/refresh"].includes(method)) { for (const overlay of this.overlays.values()) overlay.refresh(true); return null; }
      if (method === "window/showMessageRequest") {
        const actions = (params.actions ?? []).filter((action: any) => typeof action.title === "string").slice(0, 20);
        const choice = await this.o.workbench.ask(this.name, String(params.message), actions.map((action: any) => action.title));
        return actions.find((action: any) => action.title === choice) ?? null;
      }
      if (method === "workspace/configuration") return (params?.items ?? []).map((item: any) => {
        const path = item.scopeUri ? this.path(item.scopeUri) : this.o.workbench.activePath();
        const language = path ? documentLanguage(this.o, path) : undefined;
        return item.section ? this.o.kernel.configuration.get(item.section, language) ?? null : {};
      });
      if (method === "workspace/workspaceFolders") return [{ uri: this.rootUri || this.providerContext?.rootUri || "file:///workspace", name: "Workspace" }];
      if (method === "window/workDoneProgress/create") return null;
      throw new Error(`Unsupported server request ${method}`);
    });
    this.notificationSubscription = this.transport.onNotification((method, params) => {
      if (method === "oxbit/serverState") {
        if (params.name) this.name = params.name;
        if (params.state === "stopped") {
          if (params.paused !== undefined) this.paused = params.paused;
          this.error = params.error ?? "";
          this.stopped(params.error ? "failed" : "stopped");
        } else if (params.state === "running") {
          this.paused = false;
          if (!this.starting) void this.start().catch(() => {});
        } else if (["starting", "installing"].includes(params.state)) {
          this.state = params.state;
          this.changed();
        }
      }
      if (method === "oxbit/refresh") for (const overlay of this.overlays.values()) overlay.refresh(true);
      if (method === "oxbit/capabilities") {
        this.capabilities = params.capabilities ?? this.capabilities;
        this.registrations = new Map((params.registrations ?? []).map((item: LspRegistration) => [item.id, item]));
        for (const overlay of this.overlays.values()) overlay.refresh(true);
        this.updateContext(); this.providerContext?.owner.updateContext(); this.changed();
      }
      if (method === "window/showMessage") this.o.workbench.notify(String(params.message), params.type === 1 ? "error" : "info");
      if (method === "$/progress" && params.value?.message) { this.output.push(String(params.value.message).slice(0, 1000)); if (this.output.length > 100) this.output.shift(); this.changed(); }
      if (method === "window/logMessage") { this.output.push(String(params.message).slice(0, 16000)); while (this.output.join("").length > 16000) this.output.shift(); this.changed(); }
      if (method === "textDocument/publishDiagnostics" && this.state === "ready")
        void this.acceptDiagnostics(params).catch(() => {});
    });
  }
  async refreshStatus() {
    if (!(this.transport instanceof RuntimeLanguageTransport) || !this.o.runtime?.connected) return;
    for (const service of this.managedServices.values()) await service.refreshStatus();
    const generation = this.generation;
    try {
      const status = await this.transport.status();
      this.projectRootUri = status.projectRootUri ?? "";
      this.installedVersion = status.version ?? "";
      this.output = status.output ?? [];
      if (this.disposed || generation !== this.generation || this.starting) return;
      this.name = status.name ?? this.name;
      this.paused = status.paused ?? false;
      if (status.state === "ready") await this.start();
      else this.stopped(status.state);
    } catch { /* A disconnected or untrusted runtime cannot expose language status. */ }
  }
  get servers() {
    const path = this.o.workbench.activePath();
    if (!path) return [];
    const session = (this.o.runtime as any)?.session;
    return this.servicesForPath(path).filter(service => service.accepts(path)).map(service => {
      const runtime = service.transport instanceof RuntimeLanguageTransport;
      const available = !runtime || Boolean(this.o.runtime?.connected && (!session || session.trusted && session.capabilities?.includes("lsp")));
      const contribution = this.providers?.matching("transport", path).find(item => this.transports.get(item.id)?.service === service);
      const key = [...this.managedServices].find(([, value]) => value === service)?.[0];
      const id = contribution?.id ?? (key !== undefined ? `managed:${key}` : "runtime");
      return { id, name: contribution?.title ?? service.name,
        detail: [service.installedVersion, service.projectRootUri || path].filter(Boolean).join(" · "),
        state: available ? service.state : "unavailable", error: service.error, available, service };
    });
  }
  async control(id: string, action: "start" | "stop" | "restart") {
    const service = id === "runtime" ? this : id.startsWith("managed:") ? this.managedServices.get(id.slice(8))! : this.serviceForContribution(id);
    if (!service) throw new Error("Language server is no longer attached");
    if (action === "start") await service.start(true);
    else await service[action]();
  }
  private managedCandidates(path: string) {
    const definition = languageForKernel(this.o.kernel, path, this.o.documents.get(path)?.text.toString().split("\n", 1)[0]);
    const settings = this.o.kernel.configuration.get<LanguageServerSettings>("languageServers", definition.id) ?? {};
    let presets = languages.find(item => item.id === definition.id)?.providers.filter(id => id !== "local") ?? [];
    if (presets.includes("laravel")) {
      const directory = path.split("/").slice(0, -1).join("/");
      if (!this.laravelProjects.has(directory) && !this.laravelLookups.has(directory)) {
        const generation = this.laravelGeneration;
        this.laravelLookups.add(directory);
        void (async () => {
          let current = directory, found = false;
          for (;;) {
            if ((await this.o.filesystem.list(current)).some(entry => entry.name === "artisan" && entry.kind === "file")) { found = true; break; }
            if (!current) break; current = current.split("/").slice(0, -1).join("/");
          }
          return found;
        })().catch(() => false).then(found => {
          if (this.disposed || generation !== this.laravelGeneration) return;
          this.laravelProjects.set(directory, found); this.laravelLookups.delete(directory); this.providersChanged();
        });
      }
      if (!this.laravelProjects.get(directory)) presets = presets.filter(id => id !== "laravel");
    }
    const ids = new Set([...presets, ...Object.keys(settings)]);
    return [...ids].filter(id => {
      const configured = settings[id];
      if (configured?.enabled === false) return false;
      if (!configured?.selectors) return presets.includes(id);
      return configured.selectors.some(selector => (!selector.language || selector.language === "*" || selector.language === definition.id) && (!selector.pattern || matchesFilePattern(selector.pattern, path)));
    }).sort((a, b) => (settings[b]?.priority ?? 0) - (settings[a]?.priority ?? 0) || a.localeCompare(b)).map(id => ({ id, language: definition.id, title: languages.find(item => item.id === definition.id)?.title ?? definition.id }));
  }
  servicesForPath(path: string): LanguageService[] {
    if (this.providerContext) return this.providerContext.owner.servicesForPath(path);
    const contributed = (this.providers?.matching("transport", path) ?? []).filter(item => typeof (item.data as LanguageTransportProvider)?.createTransport === "function").map(item => this.serviceForContribution(item.id));
    if (!(this.transport instanceof RuntimeLanguageTransport)) return contributed.length ? contributed : this.accepts(path) ? [this] : [];
    const managed = this.managedCandidates(path).map((candidate, index) => {
      const key = index === 0 ? path : `${path}::${candidate.id}`;
      let service = this.managedServices.get(key);
      if (!service) {
        service = new LanguageService(this.o, new RuntimeLanguageTransport(this.o, path, candidate.id), { owner: this, languages: [candidate.language], path });
        service.name = candidate.title; this.managedServices.set(key, service);
        service.subscribe(() => this.providersChanged());
      }
      return service;
    });
    return [...contributed, ...managed].sort((a, b) => this.priority(b, path) - this.priority(a, path));
  }
  private priority(service: LanguageService, path: string) {
    const owner = this.providerContext?.owner ?? this;
    const contribution = owner.providers?.matching("transport", path).find(item => owner.transports.get(item.id)?.service === service);
    if (contribution) return contribution.priority ?? 0;
    const id = service.transport instanceof RuntimeLanguageTransport ? service.transport.definitionId : undefined;
    return id ? this.o.kernel.configuration.get<LanguageServerSettings>("languageServers", documentLanguage(this.o, path))?.[id]?.priority ?? 0 : 0;
  }
  eligible(path: string, method: string) { return this.servicesForPath(path).filter(service => service.state === "ready" && service.canUseLsp(path) && service.supports(method)); }
  serviceForPath(path: string): LanguageService {
    if (this.providerContext) return this;
    return this.servicesForPath(path)[0] ?? this;
  }
  private serviceForContribution(id: string): LanguageService {
    const contribution = this.o.kernel.contributions.list("transport").find(c => c.id === id);
    if (!contribution) throw new Error("Language server is no longer available");
    const provider = contribution.data as LanguageTransportProvider;
    let record = this.transports.get(contribution.id);
    if (!record || record.data !== provider) {
      if (record) {
        this.transports.delete(contribution.id);
        record.unsubscribe();
        record.controller.abort();
        record.service.dispose();
      }
      const controller = new AbortController(),
        transport = provider.createTransport({
          workspaceId: this.o.filesystem.id,
          signal: controller.signal,
        });
      const service = new LanguageService(this.o, transport, {
        owner: this,
        languages: provider.languages,
        rootUri: provider.rootUri,
        createTransport: () => provider.createTransport({ workspaceId: this.o.filesystem.id, signal: controller.signal }),
      });
      record = {
        data: provider,
        service,
        controller,
        unsubscribe: service.subscribe(() => this.providersChanged()),
      };
      this.transports.set(contribution.id, record);
    }
    return record.service;
  }
  private reconcileTransports() {
    for (const overlay of this.overlays.values()) overlay.refresh(true);
    for (const service of this.managedServices.values()) for (const overlay of service.overlays.values()) overlay.refresh(true);
    for (const [id, record] of this.transports) {
      const contribution = this.o.kernel.contributions
        .list("transport")
        .find((item) => item.id === id);
      if (contribution?.data !== record.data) {
        this.transports.delete(id);
        record.unsubscribe();
        record.controller.abort();
        record.service.dispose();
      }
    }
    this.providersChanged();
  }
  private providersChanged() {
    if (this.disposed) return;
    this.updateContext();
    const current = this.diagnostics;
    for (const path of new Set([
      ...this.publishedDiagnostics.keys(),
      ...current.keys(),
    ])) {
      const items = current.get(path) ?? [],
        value = JSON.stringify(items);
      if (this.publishedDiagnostics.get(path) !== value) {
        if (items.length) this.publishedDiagnostics.set(path, value);
        else this.publishedDiagnostics.delete(path);
        this.o.kernel.events.emit("diagnostics.change", {
          path,
          diagnostics: items,
        });
      }
    }
    for (const path of this.views.keys()) this.refreshDiagnostics(path);
    for (const service of this.managedServices.values()) for (const path of service.views.keys()) service.refreshDiagnostics(path);
    for (const record of this.transports.values())
      for (const path of record.service.views.keys())
        record.service.refreshDiagnostics(path);
    const services = [this, ...this.managedServices.values(), ...[...this.transports.values()].map(record => record.service)];
    const fingerprint = JSON.stringify(services.map(service => [service.state, service.generation, service.capabilities, [...service.registrations.values()]]));
    if (fingerprint !== this.overlayProviderFingerprint) {
      this.overlayProviderFingerprint = fingerprint;
      for (const service of services) for (const overlay of service.overlays.values()) overlay.refresh(true);
    }
    this.changed();
  }
  get diagnostics(): Map<string, any[]> {
    const result = new Map<string, any[]>();
    for (const [path, items] of this.lspDiagnostics)
      if (
        this.providerContext ||
        !this.providers?.matching("transport", path).length
      )
        result.set(path, [...items]);
    if (!this.providerContext)
      for (const [id, record] of this.transports)
        for (const [path, items] of record.service.lspDiagnostics)
          if (this.providers?.matching("transport", path).some(item => item.id === id))
            result.set(path, [...(result.get(path) ?? []), ...items]);
    if (!this.providerContext) for (const service of this.managedServices.values()) for (const [path, items] of service.lspDiagnostics) result.set(path, [...(result.get(path) ?? []), ...items]);
    const providers = this.providerContext?.owner.providers ?? this.providers;
    for (const [path, items] of providers?.diagnostics() ?? []) {
      const document = this.o.documents.get(path);
      if (!document) continue;
      const text = document.text.toString();
      const diagnostics = items
        .filter((item) => item.to <= text.length)
        .map((item) => ({
          range: {
            start: position(text, item.from),
            end: position(text, item.to),
          },
          message: item.message,
          severity: ({ error: 1, warning: 2, info: 3, hint: 4 } as const)[
            item.severity
          ],
          source: item.source,
        }));
      result.set(path, [...(result.get(path) ?? []), ...diagnostics]);
    }
    return result;
  }
  private accepts(path: string) {
    return this.providerContext
      ? this.providerContext.path ? this.providerContext.path === path : this.providerContext.languages.includes("*") ||
          this.providerContext.languages.includes(
            documentLanguage(this.o, path),
          )
      : supportedPath(path);
  }
  canUseLsp(path: string) {
    const session = (this.o.runtime as any)?.session;
    return (
      this.accepts(path) &&
      (this.providerContext || !(this.transport instanceof RuntimeLanguageTransport) || this.managedCandidates(path).length > 0) &&
      !this.paused &&
      (!(this.transport instanceof RuntimeLanguageTransport) ||
        Boolean(
          this.o.runtime?.connected &&
          (!session ||
            (session.trusted && session.capabilities?.includes("lsp"))),
        ))
    );
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private changed() {
    for (const fn of this.listeners) fn();
  }
  private shared(path: string) {
    return (
      this.transport instanceof RuntimeLanguageTransport &&
      Boolean((this.o.filesystem as any).shared?.has(path))
    );
  }
  private updateContext() {
    if (this.providerContext) return;
    const path = this.o.workbench.activePath(),
      selected = path ? this.serviceForPath(path) : this;
    const eligible = path ? this.servicesForPath(path).filter(service => service.state === "ready" && service.canUseLsp(path)) : [];
    const completion = Boolean(
        path && this.providers?.matching("completion", path).length,
      ),
      actions = Boolean(
        path && this.providers?.matching("codeAction", path).length,
      );
    const ready =
      eligible.length > 0 || selected.state === "ready" && Boolean(path && selected.canUseLsp(path));
    this.o.kernel.context.set("lsp", ready || completion || actions);
    for (const name of Object.values(capabilitiesByMethod))
      this.o.kernel.context.set(
        "lsp." + name,
        (ready && eligible.some(service => Boolean(service.effective(path)[name]))) ||
          (name === "completionProvider" && completion) ||
          (name === "codeActionProvider" && actions) || Boolean(path && this.providers?.matching("navigation", path).some(item => (item.data as import("@oxbit/sdk").NavigationProvider).operations.some(operation => name === capabilitiesByMethod["textDocument/" + operation]))),
      );
  }
  private stopped(state: string) {
    this.generation++;
    this.state = state;
    this.capabilities = {};
    this.completionIncomplete.clear();
    this.registrations.clear();
    this.fileWatchSubscription?.dispose(); this.fileWatchSubscription = undefined;
    this.syncedText.clear();
    for (const overlay of this.overlays.values()) overlay.refresh(true);
    this.synced.clear();
    this.lspDiagnostics.clear();
    this.diagnosticVersions.clear();
    for (const path of this.views.keys()) this.refreshDiagnostics(path);
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    this.updateContext();
    this.changed();
  }
  supports(method: string) {
    if (method === "codeAction/resolve")
      return Boolean(this.effective().codeActionProvider?.resolveProvider);
    return (
      !capabilitiesByMethod[method] ||
      Boolean(this.effective()[capabilitiesByMethod[method]])
    );
  }
  async start(resume = false) {
    if (this.disposed) throw new Error("Language service disposed");
    if (resume) this.paused = false;
    if (this.paused) throw new Error("Language server is stopped. Start it from Language Servers.");
    if (this.state === "ready") return;
    if (this.starting) return this.starting;
    const generation = this.generation;
    this.state = "starting";
    this.error = "";
    this.updateContext();
    this.changed();
    this.starting = (async () => {
      try {
        let result: any;
        if (this.transport instanceof RuntimeLanguageTransport) {
          if (!this.o.runtime?.connected)
            throw new Error(
              "Connect and trust a runtime workspace to use language intelligence",
            );
          result = await this.transport.start(resume);
          this.projectRootUri = result.projectRootUri ?? "";
          this.installedVersion = result.version ?? "";
        } else {
          if (this.recreateTransport && this.providerContext?.createTransport) {
            this.transport = this.providerContext.createTransport();
            this.recreateTransport = false;
            this.bindNotifications();
          }
          result = await this.transport.request("initialize", {
            processId: null,
            rootUri: this.providerContext?.rootUri ?? "file:///workspace",
            capabilities: {
              general: { positionEncodings: ["utf-16"] },
              textDocument: {
                synchronization: { dynamicRegistration: Boolean(this.transport.onRequest), didSave: true, willSave: true, willSaveWaitUntil: true },
                completion: { dynamicRegistration: Boolean(this.transport.onRequest), completionList: { itemDefaults: ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode", "data"] }, completionItem: { snippetSupport: true, commitCharactersSupport: true, insertReplaceSupport: true, documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits", "command"] } } },
                publishDiagnostics: { versionSupport: true },
                semanticTokens: { requests: { range: true, full: { delta: true } }, tokenTypes: semanticTypes, tokenModifiers: semanticModifiers, formats: ["relative"], overlappingTokenSupport: false, multilineTokenSupport: false },
                inlayHint: { resolveSupport: { properties: ["tooltip", "textEdits", "label.tooltip", "label.location"] } },
              },
              workspace: {
                configuration: Boolean(this.transport.onRequest), didChangeWatchedFiles: { dynamicRegistration: Boolean(this.transport.onRequest), relativePatternSupport: true }, workspaceFolders: true, semanticTokens: { refreshSupport: true }, inlayHint: { refreshSupport: true },
                workspaceEdit: {
                  documentChanges: true,
                  resourceOperations: ["create", "rename", "delete"],
                },
              },
            },
          });
          this.transport.notify("initialized", {});
          result.rootUri =
            this.providerContext?.rootUri ??
            result.rootUri ??
            "file:///workspace";
        }
        if (this.disposed || generation !== this.generation) throw abortError();
        this.capabilities = result.capabilities ?? result;
        if (result.registrations) this.registrations = new Map(result.registrations.map((item: LspRegistration) => [item.id, item]));
        if (result.serverInfo?.name) this.name = result.serverInfo.name;
        if (
          this.capabilities.positionEncoding &&
          this.capabilities.positionEncoding !== "utf-16"
        )
          throw new Error(
            "Unsupported LSP position encoding: " +
              this.capabilities.positionEncoding,
          );
        this.rootUri = (result.rootUri ?? "").replace(/\/$/, "");
        this.state = "ready";
        for (const overlay of this.overlays.values()) overlay.refresh(true);
        for (const doc of this.o.documents.documents.values() as Iterable<DocumentHandle>)
          await this.syncDocument(doc.path);
        this.updateContext();
      } catch (error) {
        if (generation === this.generation && !this.disposed) {
          this.state = "failed";
          this.error = String(error);
          this.updateContext();
        }
        throw error;
      } finally {
        this.starting = undefined;
        this.changed();
      }
    })();
    return this.starting;
  }
  async restart() {
    await this.stop();
    await this.start(true);
  }
  async stop() {
    this.paused = true;
    this.error = "";
    this.stopped("stopping");
    if (this.starting && this.transport instanceof RuntimeLanguageTransport) await this.o.runtime?.request("lsp.stop", this.transport.scope);
    if (this.starting) await this.starting.catch(() => {});
    try {
      if (this.transport instanceof RuntimeLanguageTransport)
        await this.o.runtime?.request("lsp.stop", this.transport.scope);
      else {
        await this.transport.request("shutdown", null);
        if (this.providerContext?.createTransport) {
          this.transport.notify("exit", null);
          this.notificationSubscription?.dispose();
          this.requestSubscription?.dispose();
          this.transport.dispose();
          this.recreateTransport = true;
        }
      }
      this.stopped("stopped");
    } catch (error) {
      this.error = String(error);
      this.stopped("failed");
      throw error;
    }
  }
  uri(path: string) {
    if (
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      path.includes("\\")
    )
      throw new Error("Language document path outside workspace");
    return (
      (this.rootUri || "file:///workspace") + "/" + path.split("/").map(encodeURIComponent).join("/")
    );
  }
  path(uri: string) {
    const root = this.rootUri || "file:///workspace";
    if (!uri.startsWith(root + "/"))
      throw new Error("Language server URI outside workspace");
    const path = uri
      .slice(root.length + 1)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    if (
      path.split("/").includes("..") ||
      path.includes("\\") ||
      path.includes("\0")
    )
      throw new Error("Language server URI outside workspace");
    return path;
  }
  private syncDocument(path: string): Promise<void> {
    if (
      this.disposed ||
      this.state !== "ready" ||
      this.shared(path) ||
      !this.accepts(path)
    )
      return Promise.resolve();
    const pending = this.syncQueue
      .catch(() => {})
      .then(async () => {
        const doc: DocumentHandle | undefined = this.o.documents.get(path);
        if (
          !doc ||
          this.disposed ||
          this.state !== "ready" ||
          this.shared(path)
        )
          return;
        const generation = this.generation,
          version = doc.version,
          previous = this.synced.get(path);
        if (previous === version) return;
        const languageId = documentLanguage(this.o, path);
        const method =
          previous === undefined
            ? "textDocument/didOpen"
            : "textDocument/didChange";
        const params =
          previous === undefined
            ? {
                textDocument: {
                  uri: this.uri(path),
                  version,
                  languageId,
                  text: doc.text.toString(),
                },
              }
            : {
                textDocument: { uri: this.uri(path), version },
                contentChanges: [{ text: doc.text.toString() }],
              };
        if (this.transport instanceof RuntimeLanguageTransport)
          await this.o.runtime!.request("lsp.notify", { method, params, ...this.transport.scope });
        else {
          const sync = synchronization(this.effective(path));
          if (previous === undefined ? sync.openClose : sync.change) {
            if (previous !== undefined && sync.change === 2) (params as any).contentChanges = [incrementalChange(this.syncedText.get(path) ?? "", doc.text.toString())];
            this.transport.notify(method, params);
          }
        }
        this.syncedText.set(path, doc.text.toString());
        if (generation === this.generation) this.synced.set(path, version);
      });
    this.syncQueue = pending;
    return pending;
  }
  private async synchronize() {
    for (const doc of this.o.documents.documents.values() as Iterable<DocumentHandle>)
      await this.syncDocument(doc.path);
    await this.o.kernel.services
      .optional<{ flush(): Promise<void> }>("collaboration")
      ?.flush();
  }
  private readSnapshot(
    path: string,
  ): Promise<import("@oxbit/sdk").FileSnapshot> {
    return this.o.runtime && this.o.filesystem.id.startsWith("runtime:")
      ? this.o.runtime.request("fs.read", { path })
      : this.o.filesystem.read(path);
  }
  private remoteVersions(): Promise<Record<string, number>> {
    return this.transport instanceof RuntimeLanguageTransport
      ? this.o.runtime!.request("lsp.versions", this.transport.scope)
      : Promise.resolve(
          Object.fromEntries(
            [...this.synced].map(([path, version]) => [
              this.uri(path),
              version,
            ]),
          ),
        );
  }
  async request<T = any>(
    method: string,
    params: any,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.start();
    if (!this.supports(method))
      throw new Error("Language server does not support " + method);
    if (signal?.aborted) throw abortError();
    await this.synchronize();
    const doc: DocumentHandle | undefined = params?.textDocument?.uri
      ? this.o.documents.get(this.path(params.textDocument.uri))
      : undefined;
    const version = doc?.version,
      generation = this.generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.activeRequests.add(controller);
    if (doc) this.requestPaths.set(controller, doc.path);
    const changed = this.o.kernel.events.on("document.change", (event) => {
      if (event.id === doc?.id) controller.abort();
    });
    try {
      const result = await this.transport.request<T>(
        method,
        params,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        this.disposed ||
        generation !== this.generation
      )
        throw abortError();
      if (doc && doc.version !== version)
        throw new Error(
          "Document changed before the language response arrived",
        );
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
      changed.dispose();
      this.activeRequests.delete(controller);
      this.requestPaths.delete(controller);
    }
  }
  async symbols(path: string, signal?: AbortSignal): Promise<import("@oxbit/sdk").DocumentSymbol[]> {
    if (signal?.aborted) throw abortError();
    const selected = this.serviceForPath(path);
    if (selected !== this) return selected.symbols(path, signal);
    if (!this.accepts(path)) throw new Error("No language server is available for this file type.");
    if (this.paused) throw new Error("Language server is stopped. Start it from Language Servers.");
    if (!this.canUseLsp(path)) throw new Error("Connect and trust a runtime workspace to load symbols.");
    await this.o.documents.open(path);
    // Initialization establishes the server's workspace URI before we form the request.
    await this.start();
    if (!this.supports("textDocument/documentSymbol")) throw new Error("This language server does not provide document symbols.");
    const values = await this.request("textDocument/documentSymbol", { textDocument: { uri: this.uri(path) } }, signal);
    return documentSymbols(values, path, uri => this.path(uri));
  }
  async at(
    method: string,
    path: string,
    index: number,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
    route = true,
  ): Promise<any> {
    if (route) { const selected = this.eligible(path, method)[0]; if (selected && selected !== this) return selected.at(method, path, index, extra, signal, false); }
    await this.start();
    const doc: DocumentHandle = await this.o.documents.open(path);
    const version = doc.version;
    const result = await this.request(
      method,
      {
        textDocument: { uri: this.uri(path) },
        position: position(doc.text.toString(), index),
        ...extra,
      },
      signal,
    );
    if (doc.version !== version)
      throw new Error("Document changed before the language response arrived");
    return result;
  }
  private async acceptDiagnostics(params: any) {
    if (this.disposed || !this.rootUri) return;
    const path = this.path(params.uri);
    if (!this.accepts(path)) return;
    if (params.version !== undefined) {
      const current = (await this.remoteVersions())[params.uri];
      if (
        (current !== undefined && params.version < current) ||
        params.version < (this.diagnosticVersions.get(path) ?? -1)
      )
        return;
      this.diagnosticVersions.set(path, params.version);
    }
    if (this.disposed) return;
    this.lspDiagnostics.set(path, params.diagnostics ?? []);
    this.refreshDiagnostics(path);
    if (this.providerContext) this.providerContext.owner.providersChanged();
    else this.providersChanged();
    this.changed();
  }
  private refreshDiagnostics(path: string) {
    for (const view of this.views.get(path) ?? []) {
      const text = view.state.doc.toString();
      const values: Diagnostic[] = [];
      for (const d of (this.providerContext?.owner ?? this).diagnostics.get(path) ?? []) {
        try {
          values.push({
            from: offset(text, d.range.start),
            to: offset(text, d.range.end),
            severity:
              d.severity === 1
                ? "error"
                : d.severity === 2
                  ? "warning"
                  : "info",
            message: d.message,
            source: d.source,
          });
        } catch {
          continue;
        }
      }
      view.dispatch(setDiagnostics(view.state, values));
    }
  }
  extensions = (path: string): CMExtension[] => {
    const selected = this.serviceForPath(path);
    if (selected !== this) return selected.extensions(path);
    const cached = this.extensionCache.get(path);
    if (cached) return cached;
    const providers = this.providerContext?.owner.providers ?? this.providers,
      hasProviders = Boolean(
        providers?.matching("completion", path).length ||
        providers?.matching("diagnostics", path).length || providers?.matching("semanticTokens", path).length || providers?.matching("inlayHints", path).length || providers?.matching("navigation", path).length,
      );
    if (!this.canUseLsp(path) && !hasProviders) return [];
    const extensions: CMExtension[] = [
      documentationPopups,
      this.overlay(path).extension(),
      ...(documentLanguage(this.o, path) === "log" ? logLinkExtensions(this.o) : []),
      autocompletion({
        interactionDelay: 0,
        override: [
          async (context: CompletionContext) => {
            if (!providers?.matching("completion", path).length) return null;
            const word = context.matchBefore(/[\w$]*/);
            if (
              !context.explicit &&
              !word?.text &&
              !providers
                .matching("completion", path)
                .some((item) =>
                  (item.data as CompletionProvider).triggerCharacters?.includes(
                    context.state.sliceDoc(
                      Math.max(0, context.pos - 1),
                      context.pos,
                    ),
                  ),
                )
            )
              return null;
            const controller = new AbortController();
            context.addEventListener("abort", () => controller.abort(), {
              onDocChange: true,
            });
            try {
              const items = await providers.completions(
                path,
                context.pos,
                controller.signal,
              );
              return {
                from: word?.from ?? context.pos,
                options: items.map((item) => ({
                  label: item.label,
                  detail: item.detail,
                  apply: (
                    view: EditorView,
                    _completion: any,
                    from: number,
                    to: number,
                  ) => {
                    if (!providers.ownsCompletion(item)) return;
                    view.dispatch({
                      annotations: pickedCompletion.of(_completion),
                      changes: {
                        from: item.from ?? from,
                        to: item.to ?? to,
                        insert: item.insertText ?? item.label,
                      },
                    });
                  },
                })),
              };
            } catch {
              return null;
            }
          },
          async (context: CompletionContext) => {
            try {
              if (!this.canUseLsp(path)) return null;
              try { await this.start(); } catch (error) { if (!this.eligible(path, "textDocument/completion").length) throw error; }
              const sources = this.eligible(path, "textDocument/completion");
              if (!sources.length) return null;
              const word = context.matchBefore(/[\w$]*/);
              if (
                !context.explicit &&
                !word?.text &&
                !(
                  sources.flatMap(source => source.effective(path).completionProvider.triggerCharacters ?? ["."])
                ).includes(
                  context.state.sliceDoc(
                    Math.max(0, context.pos - 1),
                    context.pos,
                  ),
                )
              )
                return null;
              const controller = new AbortController();
              context.addEventListener("abort", () => controller.abort(), {
                onDocChange: true,
              });
              const character = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
              const triggered = sources.some(source => source.effective(path).completionProvider.triggerCharacters?.includes(character));
              const responses = await Promise.allSettled(sources.map(async source => ({ source, result: await source.at("textDocument/completion", path, context.pos, { context: { triggerKind: triggered ? 2 : !context.explicit && this.completionIncomplete.get(path) ? 3 : 1, ...(triggered ? { triggerCharacter: character } : {}) } }, controller.signal, false) })));
              const fulfilled = responses.flatMap(response => response.status === "fulfilled" ? [response.value] : []);
              this.completionIncomplete.set(path, fulfilled.some(response => response.result?.isIncomplete));
              const items = fulfilled.flatMap(({ source, result }) => completionItems(result).map(item => ({ item, source }))), snapshot = context.state.doc.toString();
              return {
                from: word?.from ?? context.pos,
                validFor: undefined,
                options: items.map(({ item: original, source }, index: number) => {
                  const generation = source.generation;
                  let item = original, resolving: AbortController | undefined;
                  return {
                    label: item.filterText ?? item.label, displayLabel: item.label,
                    sortText: item.sortText ?? String(index).padStart(8, "0"), detail: item.detail,
                    section: sources.length > 1 ? { name: source.name, rank: sources.indexOf(source) } : undefined,
                    boost: item.preselect ? 99 : 0,
                    commitCharacters: item.commitCharacters,
                    type: item.kind === 3 ? "function" : item.kind === 6 ? "variable" : "property",
                    info: () => {
                      resolving?.abort(); resolving = new AbortController();
                      const dom = hoverDOM(item.documentation ?? "");
                      if (source.effective(path).completionProvider?.resolveProvider) {
                        const selected = resolving;
                        const changed = this.o.kernel.events.on("document.change", () => selected.abort());
                        controller.signal.addEventListener("abort", () => selected.abort(), { once: true });
                        void source.request("completionItem/resolve", item, selected.signal).then(resolved => {
                          if (selected.signal.aborted || generation !== source.generation || this.o.documents.get(path)?.text.toString() !== snapshot) return;
                          item = { ...item, ...resolved }; dom.replaceChildren(...Array.from(hoverDOM(item.documentation ?? item.detail ?? "").childNodes));
                        }).catch(() => {}).finally(() => changed.dispose());
                      }
                      return { dom, destroy: () => resolving?.abort() };
                    },
                    apply: (view: EditorView, completion: any, from: number, to: number) => {
                      if (generation !== source.generation || view.state.doc.toString() !== snapshot) return;
                      resolving?.abort();
                      try {
                        const transactions = completionTransactions(view.state, item, completion, from, to);
                        view.dispatch(transactions);
                        if (item.command && view.state.doc.eq(transactions.at(-1)!.state.doc)) void source.snapshots().then(versions => source.applyCodeAction({ title: item.label, command: item.command }, versions)).catch(error => this.o.workbench.notify(String(error), "error"));
                      } catch (error) { this.o.workbench.notify(String(error), "error"); }
                    },
                  };
                }),
              };
            } catch {
              return null;
            }
          },
        ],
      }),
      hoverTooltip(async (view, pos) => {
        try {
          if (!this.canUseLsp(path)) return null;
          await this.start();
          if (!this.eligible(path, "textDocument/hover").length) return null;
          const result = await this.at("textDocument/hover", path, pos);
          if (!result?.contents) return null;
          return {
            pos,
            above: true,
            create: () => ({ dom: hoverDOM(result.contents) }),
          };
        } catch {
          return null;
        }
      }),
      ViewPlugin.define((view) => {
        const views = this.views.get(path) ?? new Set<EditorView>();
        views.add(view);
        this.views.set(path, views);
        queueMicrotask(() => {
          if (!this.disposed && views.has(view)) {
            this.refreshDiagnostics(path);
            for (const service of this.servicesForPath(path)) if (service !== this && service.transport instanceof RuntimeLanguageTransport && service.canUseLsp(path) && service.state !== "ready") void service.start().catch(() => {});
            if (this.state !== "ready" && this.canUseLsp(path) && (this.transport instanceof RuntimeLanguageTransport || this.transport instanceof LocalLanguageTransport)) void this.start().catch(() => {});
          }
        });
        return {
          destroy: () => {
            views.delete(view);
            if (!views.size) {
              this.views.delete(path);
              for (const [controller, documentPath] of this.requestPaths)
                if (documentPath === path) controller.abort();
            }
          },
        };
      }),
      EditorView.domEventHandlers({
        keyup: (event, view) => {
          if (
            [...(this.effective(path).signatureHelpProvider?.triggerCharacters ?? []), ...(this.effective(path).signatureHelpProvider?.retriggerCharacters ?? [])].includes(event.key) &&
            this.effective(path).signatureHelpProvider
          )
            void this.signature(path, view.state.selection.main.head, event.key);
          return false;
        },
      }),
    ];
    this.extensionCache.set(path, extensions);
    return extensions;
  };
  providerLocations(path: string, index: number, operation: import("@oxbit/sdk").NavigationKind, signal?: AbortSignal) {
    return (this.providerContext?.owner.providers ?? this.providers)?.locations(path, index, operation, signal) ?? Promise.resolve([]);
  }
  rememberNavigationOrigin() {
    const owner = this.providerContext?.owner ?? this, path = this.o.workbench.activePath(), view = this.o.workbench.activeEditor();
    if (path && view) { const service = owner.serviceForPath(path), pos = position(view.state.doc.toString(), view.state.selection.main.head); owner.navigationOrigin = { service, target: { uri: service.uri(path), range: { start: pos, end: pos } } }; }
  }
  async navigate(target: NavigationTarget, remember = true, groupId?: string): Promise<void> {
    if (!target) throw new Error("No navigation target");
    const owner = this.providerContext?.owner ?? this;
    if (remember) this.rememberNavigationOrigin();
    const previous = owner.navigationOrigin;
    const pos = { ...target.range.start };
    const url = new URL(target.uri), hash = decodeURIComponent(url.hash.slice(1)); url.hash = "";
    if (hash) target = { ...target, uri: url.href };
    if (target.uri.startsWith((this.rootUri || "file:///workspace") + "/") && hash) {
      const document = await this.o.documents.open(this.path(target.uri));
      const lines = document.text.toString().split("\n"), line = /^L?(\d+)/.exec(hash);
      if (line) pos.line = Math.max(0, Number(line[1]) - 1);
      else { const heading = lines.findIndex((line: string) => /^#{1,6}\s/.test(line) && line.replace(/^#+\s+/, "").toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-") === hash); if (heading >= 0) pos.line = heading; }
    }
    if (target.uri.startsWith((this.rootUri || "file:///workspace") + "/")) await this.o.workbench.openFile(this.path(target.uri), { line: pos.line + 1, col: pos.character + 1, groupId });
    else {
      if (!(this.transport instanceof RuntimeLanguageTransport)) throw new Error("External sources require a trusted runtime preset");
      const grant = await this.o.runtime!.request<any>("lsp.external.authorize", { ...this.transport.scope, uri: target.uri });
      const source = await this.o.runtime!.request<any>("lsp.external.read", { ...this.transport.scope, handle: grant.handle });
      this.o.workbench.openView(`external:${source.uri}`, source.name, ExternalSource, { source, line: pos.line + 1, col: pos.character + 1 }, { groupId });
    }
    if (remember) { owner.navigationHistory.splice(owner.navigationIndex + 1); if (previous && JSON.stringify(owner.navigationHistory.at(-1)?.target) !== JSON.stringify(previous.target)) owner.navigationHistory.push(previous); owner.navigationOrigin = undefined; owner.navigationHistory.push({ service: this, target }); if (owner.navigationHistory.length > 200) owner.navigationHistory.shift(); owner.navigationIndex = owner.navigationHistory.length - 1; }
  }
  async navigateHistory(direction: number) {
    const owner = this.providerContext?.owner ?? this, index = owner.navigationIndex + direction;
    if (index < 0 || index >= owner.navigationHistory.length) return;
    const entry = owner.navigationHistory[index]; await entry.service.navigate(entry.target, false); owner.navigationIndex = index;
  }
  async workspaceSymbols(query: string, signal?: AbortSignal): Promise<{ service: LanguageService; target: NavigationTarget }[]> {
    const owner = this.providerContext?.owner ?? this, seen = new Set<string>(), targets = new Set<string>();
    const services = [owner, ...owner.managedServices.values(), ...[...owner.transports.values()].map(value => value.service)].filter(service => {
      const identity = service.transport instanceof RuntimeLanguageTransport ? service.transport.instanceId ?? "legacy" : service.name;
      if (seen.has(identity) || service.state !== "ready" || !service.capabilities.workspaceSymbolProvider) return false; seen.add(identity); return true;
    });
    const values = await Promise.allSettled(services.map(async service => {
      const results = await service.request("workspace/symbol", { query }, signal);
      const resolved = await Promise.all((results ?? []).map((item: any) => !item.location?.range && service.capabilities.workspaceSymbolProvider?.resolveProvider ? service.request("workspaceSymbol/resolve", item, signal) : item));
      return navigationTargets(resolved).map(target => ({ service, target }));
    }));
    signal?.throwIfAborted();
    if (values.length && values.every(value => value.status === "rejected")) throw (values[0] as PromiseRejectedResult).reason;
    return values.flatMap(value => value.status === "fulfilled" ? value.value : []).filter(({ target }) => { const id = JSON.stringify([target.uri, target.range]); if (targets.has(id)) return false; targets.add(id); return true; });
  }
  private overlay(path: string) {
    let overlay = this.overlays.get(path);
    if (!overlay) {
      const providers = this.providerContext?.owner.providers ?? this.providers;
      const server = (method: string) => this.eligible(path, method)[0];
      const contribution = (kind: "semanticTokens" | "inlayHints", method: string) => {
        const item = providers?.matching(kind, path)[0], selected = server(method);
        return item && (!selected || (item.priority ?? 0) >= this.priority(selected, path)) ? item.data : undefined;
      };
      const semantic = () => contribution("semanticTokens", "textDocument/semanticTokens") as import("@oxbit/sdk").SemanticTokensProvider | undefined;
      const hints = () => contribution("inlayHints", "textDocument/inlayHint") as import("@oxbit/sdk").InlayHintsProvider | undefined;
      overlay = new LanguageOverlays({
        capabilities: () => ({ ...this.effective(path), semanticTokensProvider: server("textDocument/semanticTokens")?.effective(path).semanticTokensProvider, inlayHintProvider: server("textDocument/inlayHint")?.effective(path).inlayHintProvider, documentLinkProvider: server("textDocument/documentLink")?.effective(path).documentLinkProvider, documentHighlightProvider: server("textDocument/documentHighlight")?.effective(path).documentHighlightProvider, ...(semantic() ? { semanticTokensProvider: { legend: semantic()!.legend, range: semantic()!.range, full: true } } : {}), ...(hints() ? { inlayHintProvider: { resolveProvider: Boolean(hints()!.resolveInlayHint) } } : {}) }),
        ready: () => this.servicesForPath(path).some(service => service.state === "ready") || Boolean(semantic() || hints()), uri: () => this.uri(path),
        request: (method, params, signal) => {
          if (method.startsWith("textDocument/semanticTokens") && semantic()) return providers!.semanticTokens(path, params.range, signal);
          if (method === "textDocument/inlayHint" && hints()) return providers!.inlayHints(path, params.range, signal);
          if (method === "inlayHint/resolve" && hints()) return providers!.resolveHint(params, signal);
          const operation = method.startsWith("textDocument/semanticTokens") ? "textDocument/semanticTokens" : method === "inlayHint/resolve" ? "textDocument/inlayHint" : method === "documentLink/resolve" ? "textDocument/documentLink" : method;
          const selected = server(operation) ?? this;
          return selected.request(method, { ...params, ...(params.textDocument ? { textDocument: { uri: selected.uri(path) } } : {}) }, signal);
        },
        enabled: setting => this.o.kernel.configuration.get<boolean>(setting, documentLanguage(this.o, path)) ?? setting !== "editor.largeFileIntelligence",
        open: async (uri, pos) => { await this.navigate({ uri, range: { start: pos, end: pos } }); },
        applyHints: async (hint, text) => {
          if (this.o.documents.get(path)?.text.toString() !== text) throw new Error("Inlay hint is obsolete");
          const document = this.o.documents.get(path)!;
          if (hint.textEdits?.length) await this.o.documents.applyEdits([{ path, expectedVersion: document.version, expectedRevision: document.savedRevision, changes: hint.textEdits.map((edit: any) => ({ from: offset(text, edit.range.start), to: offset(text, edit.range.end), insert: edit.newText })) }]);
        },
      });
      this.overlays.set(path, overlay);
    }
    return overlay;
  }
  showHover(path: string, index: number, contents: unknown) { for (const view of this.views.get(path) ?? []) showDocumentation(view, index, contents); }
  async signature(path: string, index: number, triggerCharacter?: string) {
    try {
      const result = await this.at("textDocument/signatureHelp", path, index, { context: { triggerKind: triggerCharacter ? 2 : 1, triggerCharacter, isRetrigger: Boolean(triggerCharacter && this.effective(path).signatureHelpProvider?.retriggerCharacters?.includes(triggerCharacter)) } });
      for (const view of this.views.get(path) ?? []) showSignature(view, index, result);
    } catch (error) {
      if (this.state === "ready")
        this.o.workbench.notify(String(error), "error");
    }
  }
  async beforeSave(path: string, text: string, signal: AbortSignal): Promise<string> {
    const selected = this.serviceForPath(path);
    if (selected !== this) return selected.beforeSave(path, text, signal);
    if (this.state !== "ready" || !this.accepts(path)) return text;
    const sync = synchronization(this.effective(path));
    await this.synchronize();
    const params = { textDocument: { uri: this.uri(path) }, reason: 1 };
    if (sync.willSave) this.transport.notify("textDocument/willSave", params);
    if (!sync.willSaveWaitUntil) return text;
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 1000);
    try {
      const edits = await this.request<any[]>("textDocument/willSaveWaitUntil", params, controller.signal);
      const changes = (edits ?? []).map(edit => ({ from: offset(text, edit.range.start), to: offset(text, edit.range.end), insert: edit.newText })).sort((a, b) => b.from - a.from);
      let previous = text.length;
      for (const change of changes) {
        if (change.from > change.to || change.to > previous || typeof change.insert !== "string") throw new Error("Invalid will-save edits");
        text = text.slice(0, change.from) + change.insert + text.slice(change.to); previous = change.from;
      }
      return text;
    } catch (error) { if (signal.aborted) throw error; return text; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  async snapshots(requireServer = true): Promise<Map<string, EditSnapshot>> {
    if (requireServer) {
      await this.start();
      await this.synchronize();
    }
    const versions = new Map<string, EditSnapshot>();
    let count = 0;
    const walk = async (path = "") => {
      for (const entry of await this.o.filesystem.list(path)) {
        if (++count > 10000)
          throw new Error("Workspace edit snapshot exceeds 10,000 entries");
        if (entry.kind === "directory") {
          if (![".git", "node_modules", ".oxbit"].includes(entry.name))
            await walk(entry.path);
        } else {
          const doc: DocumentHandle | undefined = this.o.documents.get(
            entry.path,
          );
          try {
            versions.set(entry.path, {
              version: doc?.version,
              revision:
                doc?.savedRevision ??
                entry.revision ??
                (await this.readSnapshot(entry.path)).revision,
            });
          } catch (error) {
            if (supportedPath(entry.path)) throw error;
          }
        }
      }
    };
    await walk();
    const remote = requireServer ? await this.remoteVersions() : {};
    for (const [path, snapshot] of versions)
      snapshot.lspVersion = remote[this.uri(path)];
    return versions;
  }
  async applyWorkspaceEdit(edit: any, versions: Map<string, EditSnapshot>) {
    if (!edit || typeof edit !== "object")
      throw new Error("Invalid language workspace edit");
    await this.synchronize();
    const remote = await this.remoteVersions();
    const changes = new Map<string, DocumentEdit>();
    const resources: ResourceEdit[] = [];
    const created = new Set<string>();
    const renamed = new Map<string, string>();
    for (const change of edit.documentChanges ?? [])
      if (change.kind === "create") created.add(this.path(change.uri));
      else if (change.kind === "rename")
        renamed.set(this.path(change.newUri), this.path(change.oldUri));
    const verify = async (path: string) => {
      const captured = versions.get(path);
      if (!captured) throw new Error("No revision captured for " + path);
      const doc: DocumentHandle | undefined = this.o.documents.get(path);
      if (captured.version !== undefined && doc?.version !== captured.version)
        throw new Error(path + " changed");
      if (doc && doc.savedRevision !== captured.revision)
        throw new Error(path + " changed on disk");
      if (
        captured.lspVersion !== undefined &&
        remote[this.uri(path)] !== captured.lspVersion
      )
        throw new Error(path + " has a stale canonical LSP version");
      const disk = await this.readSnapshot(path);
      if (disk.readonly) throw new Error("File is read-only: " + path);
      if (disk.revision !== captured.revision)
        throw new Error(path + " changed on disk");
      return captured;
    };
    const add = async (
      uri: string,
      edits: any[],
      lspVersion?: number | null,
    ) => {
      const requested = this.path(uri),
        path = renamed.get(requested) ?? requested;
      const fresh = created.has(path);
      const captured = fresh ? undefined : await verify(path);
      const doc: DocumentHandle | undefined = fresh
        ? undefined
        : await this.o.documents.open(path);
      if (
        lspVersion !== undefined &&
        lspVersion !== null &&
        lspVersion !== captured?.lspVersion
      )
        throw new Error(path + " has a stale LSP version");
      const text = doc?.text.toString() ?? "";
      const values = edits.map((e) => ({
        from: offset(text, e.range.start),
        to: offset(text, e.range.end),
        insert: e.newText,
      }));
      const current = changes.get(path);
      if (current) current.edits.push(...values);
      else
        changes.set(path, {
          path,
          expectedVersion: doc?.version ?? 0,
          ...(captured ? { expectedRevision: captured.revision } : {}),
          edits: values,
        });
    };
    for (const [uri, edits] of Object.entries(edit.changes ?? {}))
      await add(uri, edits as any[]);
    for (const change of edit.documentChanges ?? []) {
      if (change.textDocument)
        await add(
          change.textDocument.uri,
          change.edits,
          change.textDocument.version,
        );
      else {
        if (!["create", "rename", "delete"].includes(change.kind))
          throw new Error("Unsupported resource operation: " + change.kind);
        const path = this.path(change.uri ?? change.oldUri),
          to = change.newUri ? this.path(change.newUri) : undefined;
        if (change.kind !== "create") await verify(path);
        if (
          (change.kind === "create" || change.kind === "rename") &&
          versions.has(to ?? path)
        )
          throw new Error(
            "Resource destination already exists: " + (to ?? path),
          );
        resources.push({ kind: change.kind, path, to });
      }
    }
    await this.o.documents.applyEdits([...changes.values()], resources);
    await this.o.workbench.refreshFiles();
  }
  providerCodeActions(path: string, range: { from: number; to: number }) {
    return (
      (this.providerContext?.owner.providers ?? this.providers)?.codeActions(
        path,
        range,
      ) ?? Promise.resolve([])
    );
  }
  async applyProviderCodeAction(
    owner: string,
    action: ProviderCodeAction,
    versions: Map<string, EditSnapshot>,
  ) {
    const providers = this.providerContext?.owner.providers ?? this.providers;
    if (!providers?.ownsAction(owner, action))
      throw new Error("Code action provider was removed or replaced");
    const created = new Set(
      (action.resources ?? [])
        .filter((resource) => resource.kind === "create")
        .map((resource) => resource.path),
    );
    const edits = (action.edits ?? []).map((edit) => {
      const captured = versions.get(edit.path);
      if (!captured && !created.has(edit.path))
        throw new Error("No revision captured for " + edit.path);
      if (
        (edit.expectedVersion !== undefined &&
          edit.expectedVersion !== captured?.version) ||
        (edit.expectedRevision !== undefined &&
          edit.expectedRevision !== captured?.revision)
      )
        throw new Error("Provider code action has a stale revision");
      return {
        ...edit,
        expectedVersion: captured?.version,
        expectedRevision: captured?.revision,
      };
    });
    for (const resource of action.resources ?? [])
      if (resource.kind !== "create") {
        const captured = versions.get(resource.path);
        if (
          !captured ||
          (await this.readSnapshot(resource.path)).revision !==
            captured.revision ||
          (captured.version !== undefined &&
            this.o.documents.get(resource.path)?.version !== captured.version)
        )
          throw new Error(
            "Resource changed before provider action: " + resource.path,
          );
      }
    if (!edits.length && !action.resources?.length)
      throw new Error("Provider code action returned no edits");
    await this.o.documents.applyEdits(edits, action.resources ?? []);
    await this.o.workbench.refreshFiles();
  }
  async applyCodeAction(action: any, versions: Map<string, EditSnapshot>) {
    if (action.disabled)
      throw new Error(action.disabled.reason ?? "Code action disabled");
    let resolved = action;
    if (!action.edit && action.data && this.supports("codeAction/resolve"))
      resolved = await this.request("codeAction/resolve", action);
    let applied = false;
    if (resolved.edit) {
      await this.applyWorkspaceEdit(resolved.edit, versions);
      applied = true;
    }
    if (resolved.command) {
      const command =
        typeof resolved.command === "string" ? resolved : resolved.command;
      if (
        command.command === "_typescript.applyWorkspaceEdit" &&
        command.arguments?.[0]
      ) {
        await this.applyWorkspaceEdit(command.arguments[0], versions);
        applied = true;
      } else {
        if (
          !(this.capabilities.executeCommandProvider?.commands ?? []).includes(
            command.command,
          )
        )
          throw new Error(
            "Language server does not advertise command " + command.command,
          );
        if (this.commandSnapshots)
          throw new Error(
            "Another language command is applying workspace edits",
          );
        this.commandSnapshots = versions;
        let result: any;
        try {
          result = await this.request<any>("workspace/executeCommand", command);
        } finally {
          this.commandSnapshots = undefined;
        }
        if (result?.applied === false)
          throw new Error(
            result.failureReason ?? "Language command did not apply changes",
          );
        if (result?.edit) await this.applyWorkspaceEdit(result.edit, versions);
        else if (result?.changes || result?.documentChanges)
          await this.applyWorkspaceEdit(result, versions);
        applied = true;
      }
    }
    if (!applied)
      throw new Error("Code action returned no applicable edit or command");
  }
  dispose() {
    if (this.disposed) return;
    this.providers?.dispose();
    for (const overlay of this.overlays.values()) overlay.dispose();
    this.overlays.clear();
    this.extensionCache.clear();
    for (const service of this.managedServices.values()) service.dispose();
    this.managedServices.clear();
    for (const record of this.transports.values()) {
      record.unsubscribe();
      record.controller.abort();
      record.service.dispose();
    }
    this.transports.clear();
    for (const path of this.synced.keys())
      if (!this.shared(path))
        this.transport.notify("textDocument/didClose", {
          textDocument: { uri: this.uri(path) },
        });
    this.disposed = true;
    this.stopped("disposed");
    this.transport.dispose();
    this.notificationSubscription?.dispose();
    for (const off of this.subscriptions) off();
    this.views.clear();
    this.listeners.clear();
  }
}
export function createFeature(o: FeatureOptions): Extension {
  let language: LanguageService;
  function Problems() {
    const [, render] = useState(0);
    useEffect(() => language.subscribe(() => render((x) => x + 1)), []);
    const path = o.workbench.activePath(),
      selected = path ? language.serviceForPath(path) : language;
    return React.createElement(
      "div",
      {
        style: { padding: 12, overflow: "auto", height: "100%" },
        onContextMenu: (event: React.MouseEvent) => {
          event.preventDefault();
          o.workbench.showContextMenu("problem", event.clientX, event.clientY);
        },
      },
      selected.state !== "ready" &&
        path &&
        selected.canUseLsp(path) &&
        React.createElement(
          "button",
          {
            onClick: () =>
              void selected
                .start()
                .catch((e) => o.workbench.notify(String(e), "error")),
          },
          tr("Start language server"),
        ),
      ...Array.from(language.diagnostics, ([path, items]) =>
        React.createElement(
          "section",
          { key: path },
          React.createElement("strong", null, path),
          ...items.map((d: any, i: number) =>
            React.createElement(
              "button",
              {
                key: i,
                onClick: () =>
                  o.workbench.openFile(path, {
                    line: d.range.start.line + 1,
                    col: d.range.start.character + 1,
                  }),
                style: { display: "block", textAlign: "left", padding: 4 },
              },
              `${d.severity === 1 ? "Error" : "Warning"} ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`,
            ),
          ),
        ),
      ),
    );
  }
  function Results({
    items,
    service = language,
    groupId,
  }: {
    items: any[];
    service?: LanguageService;
    groupId?: string;
  }) {
    return React.createElement(
      "div",
      { style: { padding: 16 } },
      ...items.map((r, i) =>
        React.createElement(
          "button",
          {
            key: i,
            style: { display: "block" },
            onClick: () =>
              void (r.service ?? service).navigate(navigationTargets(r)[0], true, groupId).catch((error: unknown) => o.workbench.notify(String(error), "error")),
          },
          r.name ??
            `${decodeURI(r.uri ?? r.targetUri)}:${(r.range ?? r.targetSelectionRange).start.line + 1}`,
        ),
      ),
    );
  }
  const active = () => {
    const path = o.workbench.activePath();
    const view = o.workbench.activeEditor();
    if (!path || !view) throw new Error("Open an editor first");
    return {
      path,
      index: view.state.selection.main.head,
      target: language.serviceForPath(path),
    };
  };
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.language",
      name: "TypeScript Language Intelligence",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["lsp", "filesystem.read", "filesystem.write"],
    },
    activate(ctx) {
      for (const id of ["zsh", "jsonl", "ini", "dotenv", "csv", "log"]) ctx.own(ctx.contributions.register({
        id: `language.local.${id}`, kind: "transport", title: `Oxbit ${id}`, priority: -10,
        data: { languages: [id], createTransport: () => new LocalLanguageTransport(id) },
      }));
      language = new LanguageService(o);
      ctx.subscribe(() => {
        for (const id of ["references", "symbols", "code-actions"])
          o.workbench.closeView(id);
      });
      ctx.own(ctx.hooks.beforeSave("language.willSave", ({ path, text, signal }) => language.beforeSave(path, text, signal), 0));
      ctx.own(ctx.events.on("document.save", ({ id }) => {
        const doc = [...o.documents.documents.values() as Iterable<DocumentHandle>].find(doc => doc.id === id);
        if (!doc) return;
        const selected = language.serviceForPath(doc.path);
        if (selected.transport instanceof RuntimeLanguageTransport || selected.state !== "ready") return;
        const save = synchronization(selected.effective(doc.path)).save;
        if (save) selected.transport.notify("textDocument/didSave", { textDocument: { uri: selected.uri(doc.path) }, ...(typeof save === "object" && save.includeText ? { text: doc.text.toString() } : {}) });
      }));
      ctx.own(ctx.services.register("language", language));
      ctx.own(language);
      ctx.own(ctx.contributions.register({
        id: "language.status", kind: "statusItem", title: "Language Servers", location: "right", order: 10,
        component: () => React.createElement(LanguageStatus, { language, o }),
      }));
      ctx.own(
        ctx.contributions.register({
          id: "problems",
          kind: "panel",
          title: "Problems",
          component: Problems,
          order: 20,
        }),
      );
      const methods: Record<string, string> = {
        "editor.gotoDefinition": "textDocument/definition",
        "editor.gotoDeclaration": "textDocument/declaration", "editor.gotoTypeDefinition": "textDocument/typeDefinition", "editor.gotoImplementation": "textDocument/implementation",
        "editor.incomingCalls": "textDocument/prepareCallHierarchy", "editor.outgoingCalls": "textDocument/prepareCallHierarchy", "editor.supertypes": "textDocument/prepareTypeHierarchy", "editor.subtypes": "textDocument/prepareTypeHierarchy",
        "editor.references": "textDocument/references",
        "editor.rename": "textDocument/rename",
        "editor.codeAction": "textDocument/codeAction",
        "editor.hover": "textDocument/hover",
        "editor.signature": "textDocument/signatureHelp",
        "editor.symbols": "textDocument/documentSymbol",
        "editor.formatLsp": "textDocument/formatting",
      };
      const command = (id: string, title: string, run: (args?: unknown) => unknown) =>
        ctx.own(
          ctx.commands.register({
            id,
            title,
            run,
            ...(methods[id]
              ? { when: "editor && lsp." + capabilitiesByMethod[methods[id]] }
              : {}),
          }),
        );
      command("lsp.restart", "Restart Language Server", () => {
        const path = o.workbench.activePath();
        return (path ? language.serviceForPath(path) : language).restart();
      });
      command("lsp.start", "Start Language Server", () => {
        const path = o.workbench.activePath();
        return (path ? language.serviceForPath(path) : language).start(true);
      });
      command("lsp.stop", "Stop Language Server", () => {
        const path = o.workbench.activePath();
        return (path ? language.serviceForPath(path) : language).stop();
      });
      command("editor.navigateBack", "Go Back", () => language.navigateHistory(-1));
      command("editor.navigateForward", "Go Forward", () => language.navigateHistory(1));
      command("editor.workspaceSymbols", "Workspace Symbols", () => { language.rememberNavigationOrigin(); o.workbench.openView("workspace-symbols", "Workspace Symbols", WorkspaceSymbols, { service: language }); });
      if (o.runtime) command("project.intelligence", "Project Intelligence", () => o.workbench.openView("project-intelligence", "Project Intelligence", ProjectIntelligenceView, { options: o, path: o.workbench.activePath() }));
      for (const [id, prepare, method, title] of [
        ["editor.incomingCalls", "textDocument/prepareCallHierarchy", "callHierarchy/incomingCalls", "Incoming Calls"],
        ["editor.outgoingCalls", "textDocument/prepareCallHierarchy", "callHierarchy/outgoingCalls", "Outgoing Calls"],
        ["editor.supertypes", "textDocument/prepareTypeHierarchy", "typeHierarchy/supertypes", "Supertypes"],
        ["editor.subtypes", "textDocument/prepareTypeHierarchy", "typeHierarchy/subtypes", "Subtypes"],
      ]) command(id, title, async () => { const { path, index, target } = active(); const items = await target.at(prepare, path, index); language.rememberNavigationOrigin(); o.workbench.openView("language-hierarchy", title, Hierarchy, { service: target, items: items ?? [], method }); });
      for (const [id, method, title] of [
        ["editor.gotoDeclaration", "textDocument/declaration", "Go to Declaration"],
        ["editor.gotoTypeDefinition", "textDocument/typeDefinition", "Go to Type Definition"],
        ["editor.gotoImplementation", "textDocument/implementation", "Go to Implementation"],
        [
          "editor.gotoDefinition",
          "textDocument/definition",
          "Go to Definition",
        ],
        ["editor.references", "textDocument/references", "Find References"],
      ])
        command(id, title, async (args) => {
          const { path, index, target } = active();
          const groupId = typeof (args as { groupId?: unknown } | undefined)?.groupId === "string"
            ? (args as { groupId: string }).groupId : undefined;
          if (!target.eligible(path, method).length && target.canUseLsp(path)) await target.start();
          const responses = await Promise.allSettled(target.eligible(path, method).map(async service => {
            const result = await service.at(method, path, index, method.endsWith("references") ? { context: { includeDeclaration: true } } : {}, undefined, false);
            return navigationTargets(result).map(item => ({ ...item, service }));
          }));
          const provided = await language.providerLocations(path, index, method.split("/")[1] as import("@oxbit/sdk").NavigationKind);
          const raw = [...responses.flatMap(response => response.status === "fulfilled" ? response.value : []), ...navigationTargets(provided).map(item => ({ ...item, service: target }))];
          const seen = new Set<string>();
          const items = raw.filter(item => { const id = JSON.stringify([item.uri, item.range]); if (seen.has(id)) return false; seen.add(id); return true; });
          if (items.length === 1) {
            const r = items[0];
            await r.service.navigate(r, true, groupId);
          } else {
            language.rememberNavigationOrigin();
            o.workbench.openView("references", title, Results, { items, service: target, groupId }, { groupId });
          }
        });
      command("editor.rename", "Rename Symbol", async () => {
        const { path, index, target } = active();
        let placeholder = "";
        if (target.capabilities.renameProvider?.prepareProvider) {
          const prepared = await target.at("textDocument/prepareRename", path, index);
          if (!prepared) throw new Error("This symbol cannot be renamed");
          const range = prepared.range ?? (prepared.start ? prepared : undefined), text = o.documents.get(path)!.text.toString();
          placeholder = prepared.placeholder ?? (range ? text.slice(offset(text, range.start), offset(text, range.end)) : "");
        }
        const newName = await o.workbench.prompt(tr("Rename Symbol"), placeholder);
        if (!newName) return;
        const versions = await target.snapshots(target.canUseLsp(path));
        const edit = await target.at("textDocument/rename", path, index, {
          newName,
        });
        if (edit) await target.applyWorkspaceEdit(edit, versions);
      });
      command("editor.codeAction", "Code Actions", async () => {
        const { path, index, target } = active();
        const doc = await o.documents.open(path);
        const pos = position(doc.text.toString(), index);
        const versions = await target.snapshots(target.canUseLsp(path));
        const actions: any[] =
          target.canUseLsp(path) && target.supports("textDocument/codeAction")
            ? ((await target.request<any[]>("textDocument/codeAction", {
                textDocument: { uri: target.uri(path) },
                range: { start: pos, end: pos },
                context: { diagnostics: target.diagnostics.get(path) ?? [] },
              })) ?? [])
            : [];
        const provided = await language.providerCodeActions(path, {
          from: index,
          to: index,
        });
        actions.push(
          ...provided.map((item) => ({
            title: item.action.title,
            provider: item,
          })),
        );
        if (!actions?.length) {
          o.workbench.notify("No code actions available");
          return;
        }
        function Actions() {
          return React.createElement(
            "div",
            { style: { padding: 16 } },
            ...actions.map((action, i) =>
              React.createElement(
                "button",
                {
                  key: i,
                  style: { display: "block" },
                  disabled: Boolean(action.disabled),
                  title: action.disabled?.reason,
                  onClick: () => {
                    void (async () => {
                      if (action.provider)
                        await target.applyProviderCodeAction(
                          action.provider.owner,
                          action.provider.action,
                          versions,
                        );
                      else await target.applyCodeAction(action, versions);
                      o.workbench.closeView("code-actions");
                    })().catch((e) => o.workbench.notify(String(e), "error"));
                  },
                },
                action.title,
              ),
            ),
          );
        }
        o.workbench.openView("code-actions", "Code Actions", Actions);
      });
      command("editor.hover", "Show Hover", async () => {
        const { path, index, target } = active();
        const result = await target.at("textDocument/hover", path, index);
        if (result?.contents) target.showHover(path, index, result.contents);
      });
      command("editor.signature", "Show Signature Help", () => {
        const { path, index, target } = active();
        return target.signature(path, index);
      });
      command("editor.symbols", "Go to Symbol", () => ctx.commands.execute("workbench.gotoSymbol"));
      command("editor.formatLsp", "Format with Language Server", async () => {
        const { path, target } = active();
        const versions = await target.snapshots(target.canUseLsp(path));
        await target.start();
        const edits = await target.request<any[]>("textDocument/formatting", {
          textDocument: { uri: target.uri(path) },
          options: {
            tabSize: o.kernel.configuration.get<number>("editor.tabSize") ?? 2,
            insertSpaces:
              o.kernel.configuration.get<boolean>("editor.insertSpaces") ??
              true,
          },
        });
        if (edits?.length)
          await target.applyWorkspaceEdit(
            { changes: { [target.uri(path)]: edits } },
            versions,
          );
      });
    },
  };
}
