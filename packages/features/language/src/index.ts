import { translate as tr } from "@zapp/ui";
import React, { useState, useEffect } from "react";
import {
  autocompletion,
  type CompletionContext,
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
} from "@zapp/sdk";
import { LanguageProviders, documentLanguage } from "./providers.js";
import type { DocumentHandle } from "@zapp/documents";
export interface EditSnapshot {
  version?: number;
  revision: string;
  lspVersion?: number;
}
const capabilitiesByMethod: Record<string, string> = {
  "textDocument/completion": "completionProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/definition": "definitionProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/codeAction": "codeActionProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
  "textDocument/formatting": "documentFormattingProvider",
  "workspace/executeCommand": "executeCommandProvider",
};
const supportedPath = (path: string) =>
  /\.(?:[cm]?tsx?|[cm]?jsx?|json)$/.test(path);
const abortError = () =>
  new DOMException("Language request cancelled", "AbortError");
type Position = { line: number; character: number };
export function offset(text: string, pos: Position) {
  const lines = text.split("\n");
  if (!Number.isInteger(pos.line) || pos.line < 0 || pos.line >= lines.length)
    throw new Error("Language server returned an invalid line");
  let start = 0;
  for (let i = 0; i < pos.line; i++) start += lines[i].length + 1;
  if (
    !Number.isInteger(pos.character) ||
    pos.character < 0 ||
    pos.character > lines[pos.line].replace(/\r$/, "").length
  )
    throw new Error("Language server returned an invalid column");
  return start + pos.character;
}
export function position(text: string, index: number): Position {
  if (!Number.isInteger(index) || index < 0 || index > text.length)
    throw new Error("Invalid document offset");
  const lines = text.slice(0, index).split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}
function content(value: any): string {
  if (Array.isArray(value)) return value.map(content).join("\n");
  return typeof value === "string"
    ? value
    : (value?.value ?? value?.label ?? "");
}
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
  constructor(private worker: Worker) {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p.cleanup();
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        }
      } else for (const fn of this.listeners) fn(m.method, m.params);
    };
    worker.onerror = (e) => {
      for (const p of this.pending.values()) {
        p.cleanup();
        p.reject(new Error(e.message));
      }
      this.pending.clear();
      for (const fn of this.listeners)
        fn("zapp/serverState", { state: "stopped", error: e.message });
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
  dispose() {
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
  constructor(private o: FeatureOptions) {}
  request<T>(method: string, params: unknown, signal?: AbortSignal) {
    if (!this.o.runtime)
      return Promise.reject(new Error("Runtime unavailable"));
    return this.o.runtime.request<T>(
      "lsp.request",
      { method, params },
      { signal },
    );
  }
  notify(method: string, params: unknown) {
    void this.o.runtime
      ?.request("lsp.notify", { method, params })
      .catch((e) => this.o.workbench.notify(String(e), "error"));
  }
  onNotification(fn: (method: string, params: any) => void) {
    return {
      dispose:
        this.o.runtime?.subscribe("lsp.notification", (p) =>
          fn(p.method, p.params),
        ) ?? (() => {}),
    };
  }
  dispose() {
    /* The runtime owns the shared language server process. */
  }
}
export class LanguageService {
  capabilities: Record<string, any> = {};
  rootUri = "";
  state = "unavailable";
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
  readonly transport: LanguageTransport;
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
    },
  ) {
    this.transport =
      transport ??
      o.kernel.services.optional<LanguageTransport>("language.transport") ??
      new RuntimeLanguageTransport(o);
    this.subscriptions.push(
      this.transport.onNotification((method, params) => {
        if (method === "zapp/serverState" && params.state === "stopped") {
          this.stopped("stopped");
          if (params.error) o.workbench.notify(params.error, "error");
        }
        if (method === "textDocument/publishDiagnostics")
          void this.acceptDiagnostics(params).catch(() => {});
      }).dispose,
    );
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
            if (!this.shared(path))
              this.transport.notify("textDocument/didClose", {
                textDocument: { uri: this.uri(path) },
              });
            this.synced.delete(path);
            this.lspDiagnostics.delete(path);
          }
      }).dispose,
    );
    if (o.runtime && this.transport instanceof RuntimeLanguageTransport)
      this.subscriptions.push(
        o.runtime.subscribe("lsp.applyEdit", (params) => {
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
          else if (this.state === "disconnected")
            void this.start().catch((error) =>
              o.workbench.notify(String(error), "error"),
            );
        }),
      );
    if (!this.providerContext) {
      this.providers = new LanguageProviders(o, () => this.providersChanged());
      this.subscriptions.push(
        o.kernel.contributions.subscribe(() => this.reconcileTransports()),
        o.kernel.events.on("editor.active", () => this.updateContext()).dispose,
      );
      this.providersChanged();
    }
  }
  serviceForPath(path: string): LanguageService {
    if (this.providerContext) return this;
    const contribution = this.providers
      ?.matching("transport", path)
      .find(
        (item) =>
          typeof (item.data as LanguageTransportProvider)?.createTransport ===
          "function",
      );
    if (!contribution) return this;
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
    for (const record of this.transports.values())
      for (const path of record.service.views.keys())
        record.service.refreshDiagnostics(path);
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
          if (this.providers?.matching("transport", path)[0]?.id === id)
            result.set(path, [...items]);
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
      ? this.providerContext.languages.includes("*") ||
          this.providerContext.languages.includes(
            documentLanguage(this.o, path),
          )
      : supportedPath(path);
  }
  canUseLsp(path: string) {
    const session = (this.o.runtime as any)?.session;
    return (
      this.accepts(path) &&
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
    const completion = Boolean(
        path && this.providers?.matching("completion", path).length,
      ),
      actions = Boolean(
        path && this.providers?.matching("codeAction", path).length,
      );
    const ready =
      selected.state === "ready" && Boolean(path && selected.canUseLsp(path));
    this.o.kernel.context.set("lsp", ready || completion || actions);
    for (const name of Object.values(capabilitiesByMethod))
      this.o.kernel.context.set(
        "lsp." + name,
        (ready && Boolean(selected.capabilities[name])) ||
          (name === "completionProvider" && completion) ||
          (name === "codeActionProvider" && actions),
      );
  }
  private stopped(state: string) {
    this.generation++;
    this.state = state;
    this.capabilities = {};
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
      return Boolean(this.capabilities.codeActionProvider?.resolveProvider);
    return (
      !capabilitiesByMethod[method] ||
      Boolean(this.capabilities[capabilitiesByMethod[method]])
    );
  }
  async start() {
    if (this.disposed) throw new Error("Language service disposed");
    if (this.state === "ready") return;
    if (this.starting) return this.starting;
    const generation = this.generation;
    this.state = "starting";
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
          result = await this.o.runtime.request("lsp.start");
        } else {
          result = await this.transport.request("initialize", {
            processId: null,
            rootUri: this.providerContext?.rootUri ?? "file:///workspace",
            capabilities: {
              general: { positionEncodings: ["utf-16"] },
              textDocument: {
                completion: { completionItem: { snippetSupport: false } },
                publishDiagnostics: { versionSupport: true },
              },
              workspace: {
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
        for (const doc of this.o.documents.documents.values() as Iterable<DocumentHandle>)
          await this.syncDocument(doc.path);
        this.updateContext();
      } catch (error) {
        if (generation === this.generation && !this.disposed) {
          this.state = "failed";
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
    this.stopped("restarting");
    if (this.starting) await this.starting.catch(() => {});
    if (this.transport instanceof RuntimeLanguageTransport)
      await this.o.runtime?.request("lsp.restart");
    else await this.transport.request("shutdown", null).catch(() => {});
    await this.start();
  }
  uri(path: string) {
    if (
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      path.includes("\\")
    )
      throw new Error("Language document path outside workspace");
    return (
      this.rootUri + "/" + path.split("/").map(encodeURIComponent).join("/")
    );
  }
  path(uri: string) {
    if (!this.rootUri || !uri.startsWith(this.rootUri + "/"))
      throw new Error("Language server URI outside workspace");
    const path = uri
      .slice(this.rootUri.length + 1)
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
        const version = doc.version,
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
          await this.o.runtime!.request("lsp.notify", { method, params });
        else this.transport.notify(method, params);
        this.synced.set(path, version);
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
  ): Promise<import("@zapp/sdk").FileSnapshot> {
    return this.o.runtime && this.o.filesystem.id.startsWith("runtime:")
      ? this.o.runtime.request("fs.read", { path })
      : this.o.filesystem.read(path);
  }
  private remoteVersions(): Promise<Record<string, number>> {
    return this.transport instanceof RuntimeLanguageTransport
      ? this.o.runtime!.request("lsp.versions")
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
  async at(
    method: string,
    path: string,
    index: number,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
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
      for (const d of this.diagnostics.get(path) ?? []) {
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
    const providers = this.providerContext?.owner.providers ?? this.providers,
      hasProviders = Boolean(
        providers?.matching("completion", path).length ||
        providers?.matching("diagnostics", path).length,
      );
    if (!this.canUseLsp(path) && !hasProviders) return [];
    return [
      autocompletion({
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
                  ) =>
                    view.dispatch({
                      changes: {
                        from: item.from ?? from,
                        to: item.to ?? to,
                        insert: item.insertText ?? item.label,
                      },
                    }),
                })),
              };
            } catch {
              return null;
            }
          },
          async (context: CompletionContext) => {
            try {
              if (!this.canUseLsp(path)) return null;
              await this.start();
              if (!this.capabilities.completionProvider) return null;
              const word = context.matchBefore(/[\w$]*/);
              if (
                !context.explicit &&
                !word?.text &&
                !(
                  this.capabilities.completionProvider.triggerCharacters ?? [
                    ".",
                  ]
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
              const result = await this.at(
                "textDocument/completion",
                path,
                context.pos,
                {},
                controller.signal,
              );
              const items = Array.isArray(result)
                ? result
                : (result?.items ?? []);
              return {
                from: word?.from ?? context.pos,
                options: items.map((item: any) => ({
                  label: item.label,
                  detail: item.detail,
                  type:
                    item.kind === 3
                      ? "function"
                      : item.kind === 6
                        ? "variable"
                        : "property",
                  apply: (
                    view: EditorView,
                    _completion: any,
                    from: number,
                    to: number,
                  ) => {
                    const textEdit = item.textEdit;
                    const text = view.state.doc.toString();
                    const range = textEdit?.range ?? textEdit?.replace;
                    const insert = (
                      textEdit?.newText ??
                      item.insertText ??
                      item.label
                    )
                      .replace(/\$\{\d+:([^}]+)\}/g, "$1")
                      .replace(/\$\d+|\$\{\d+\}/g, "");
                    const change = {
                      from: range ? offset(text, range.start) : from,
                      to: range ? offset(text, range.end) : to,
                      insert,
                    };
                    view.dispatch({
                      changes: [
                        change,
                        ...(item.additionalTextEdits ?? []).map((e: any) => ({
                          from: offset(text, e.range.start),
                          to: offset(text, e.range.end),
                          insert: e.newText,
                        })),
                      ],
                    });
                  },
                })),
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
          if (!this.capabilities.hoverProvider) return null;
          const result = await this.at("textDocument/hover", path, pos);
          if (!result?.contents) return null;
          return {
            pos,
            above: true,
            create: () => {
              const dom = document.createElement("div");
              dom.className = "lsp-tooltip";
              dom.style.cssText =
                "max-width:560px;padding:10px;white-space:pre-wrap";
              dom.textContent = content(result.contents);
              return { dom };
            },
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
          if (!this.disposed && views.has(view)) this.refreshDiagnostics(path);
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
            (event.key === "(" || event.key === ",") &&
            this.capabilities.signatureHelpProvider
          )
            void this.signature(path, view.state.selection.main.head);
          return false;
        },
      }),
    ];
  };
  async signature(path: string, index: number) {
    try {
      const result = await this.at("textDocument/signatureHelp", path, index);
      const label = result?.signatures?.[result.activeSignature ?? 0]?.label;
      if (label) this.o.workbench.notify(label);
    } catch (error) {
      if (this.state === "ready")
        this.o.workbench.notify(String(error), "error");
    }
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
          if (![".git", "node_modules", ".zapp"].includes(entry.name))
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
  }: {
    items: any[];
    service?: LanguageService;
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
              void o.workbench.openFile(service.path(r.uri ?? r.targetUri), {
                line: (r.range ?? r.targetSelectionRange).start.line + 1,
                col: (r.range ?? r.targetSelectionRange).start.character + 1,
              }),
          },
          r.name ??
            `${service.path(r.uri ?? r.targetUri)}:${(r.range ?? r.targetSelectionRange).start.line + 1}`,
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
      id: "zapp.language",
      name: "TypeScript Language Intelligence",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["lsp", "filesystem.read", "filesystem.write"],
    },
    activate(ctx) {
      language = new LanguageService(o);
      ctx.subscribe(() => {
        for (const id of ["references", "symbols", "code-actions"])
          o.workbench.closeView(id);
      });
      ctx.own(ctx.services.register("language", language));
      ctx.own(language);
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
        "editor.references": "textDocument/references",
        "editor.rename": "textDocument/rename",
        "editor.codeAction": "textDocument/codeAction",
        "editor.hover": "textDocument/hover",
        "editor.signature": "textDocument/signatureHelp",
        "editor.symbols": "textDocument/documentSymbol",
        "editor.formatLsp": "textDocument/formatting",
      };
      const command = (id: string, title: string, run: () => unknown) =>
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
      for (const [id, method, title] of [
        [
          "editor.gotoDefinition",
          "textDocument/definition",
          "Go to Definition",
        ],
        ["editor.references", "textDocument/references", "Find References"],
      ])
        command(id, title, async () => {
          const { path, index, target } = active();
          const result = await target.at(
            method,
            path,
            index,
            method.endsWith("references")
              ? { context: { includeDeclaration: true } }
              : {},
          );
          const items = Array.isArray(result) ? result : result ? [result] : [];
          if (items.length === 1) {
            const r = items[0];
            await o.workbench.openFile(target.path(r.uri ?? r.targetUri), {
              line: (r.range ?? r.targetSelectionRange).start.line + 1,
              col: (r.range ?? r.targetSelectionRange).start.character + 1,
            });
          } else
            o.workbench.openView("references", "References", Results, {
              items,
              service: target,
            });
        });
      command("editor.rename", "Rename Symbol", async () => {
        const { path, index, target } = active();
        const newName = await o.workbench.prompt(tr("Rename Symbol"));
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
        o.workbench.notify(content(result?.contents) || "No hover information");
      });
      command("editor.signature", "Show Signature Help", () => {
        const { path, index, target } = active();
        return target.signature(path, index);
      });
      command("editor.symbols", "Go to Symbol", async () => {
        const { path, target } = active();
        await target.start();
        const symbols = await target.request<any[]>(
          "textDocument/documentSymbol",
          {
            textDocument: { uri: target.uri(path) },
          },
        );
        const flatten = (items: any[]): any[] =>
          items.flatMap((s) => [
            {
              name: s.name,
              uri: s.location?.uri ?? target.uri(path),
              range: s.location?.range ?? s.selectionRange,
            },
            ...flatten(s.children ?? []),
          ]);
        o.workbench.openView("symbols", "Symbols", Results, {
          items: flatten(symbols ?? []),
          service: target,
        });
      });
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
