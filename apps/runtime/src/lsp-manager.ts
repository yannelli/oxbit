import path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { languageIdForPath, resolveLanguage, matchesFilePattern, validateFileAssociations, validateLanguageServers, type LanguageServerDefinition } from "@oxbit/sdk";
import { RpcError } from "@oxbit/protocol";
import { LanguageServer } from "./lsp.js";
import { WorkspaceFiles } from "./filesystem.js";
import { serverCatalog, resolveLaunch, type LaunchSpec } from "./managed/catalog.js";
import { ManagedInstaller, fingerprint } from "./managed/install.js";
import { setting } from "./branding.js";

interface Instance {
  id: string;
  definition: LanguageServerDefinition;
  root: string;
  fingerprint: string;
  server: LanguageServer;
  attachments: Map<string, Set<string>>;
  associations: Record<string, string>;
  queue: Promise<unknown>;
  idle?: ReturnType<typeof setTimeout>;
  lifecycle: number;
}
function merge(a: any, b: any): any {
  if (!a || !b || Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object") return b ?? a;
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key, merge(a[key], b[key])]));
}
export class LanguageServerManager {
  private instances = new Map<string, Instance>();
  private canonicalDocuments = new Map<string, string>();
  private defaultServer: LanguageServer;
  private defaultLifecycle = 0;
  private defaultQueue: Promise<unknown> = Promise.resolve();
  private installer: ManagedInstaller;
  constructor(private files: WorkspaceFiles, cache: string, private emit: (method: string, params: any, instanceId?: string) => void, private idleMs = 300_000) {
    this.installer = new ManagedInstaller(cache);
    this.defaultServer = new LanguageServer(files, emit);
  }
  private get(id?: string) {
    if (!id) return this.defaultServer;
    const instance = this.instances.get(id);
    if (!instance) throw new RpcError("LSP_INSTANCE_NOT_FOUND", "Language server instance is no longer available");
    return instance.server;
  }
  private serialize<T>(id: string | undefined, operation: () => Promise<T>): Promise<T> {
    const instance = id ? this.instances.get(id) : undefined;
    if (!instance) {
      const pending = this.defaultQueue.catch(() => {}).then(operation);
      this.defaultQueue = pending; return pending;
    }
    const pending = instance.queue.catch(() => {}).then(operation);
    instance.queue = pending; return pending;
  }
  async projectRoot(relative: string, markers: string[]) {
    await this.files.resolve(relative, true);
    let current = path.dirname(path.join(this.files.root, relative));
    while (this.files.inside(current)) {
      for (const marker of markers) {
        const candidate = path.relative(this.files.root, path.join(current, marker));
        try { await fs.stat(await this.files.resolve(candidate)); return current; }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      }
      if (current === this.files.root) break;
      current = path.dirname(current);
    }
    return this.files.root;
  }
  private matches(instance: Pick<Instance, "definition" | "associations" | "root">, relative: string, text?: string) {
    const full = path.join(this.files.root, relative);
    if (full !== instance.root && !full.startsWith(instance.root + path.sep)) return false;
    const language = resolveLanguage(relative, { associations: instance.associations, firstLine: text?.split("\n", 1)[0] }).id;
    return instance.definition.selectors.some(selector => (!selector.language || selector.language === language || selector.language === "*") && (!selector.pattern || matchesFilePattern(selector.pattern, relative)));
  }
  async attach(relative: string, owner: string, settings: unknown = {}, associationsInput: unknown = {}, preferred?: string) {
    validateLanguageServers(settings); validateFileAssociations(associationsInput);
    const associations = associationsInput as Record<string, string>;
    const full = await this.files.resolve(relative, true);
    const text = this.canonicalDocuments.get(relative) ?? await fs.readFile(full, "utf8").catch(() => "");
    const definitions = [...serverCatalog.map(preset => ({ ...preset, ...settings[preset.id] })), ...Object.entries(settings).filter(([id]) => !serverCatalog.some(preset => preset.id === id)).map(([id, config]) => ({ id, name: id, rootMarkers: [], selectors: [], ...config }))];
    const candidates = definitions.filter(definition => definition.enabled !== false && (!preferred || definition.id === preferred) && this.matches({ definition, root: this.files.root, associations }, relative, text)).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
    const definition = candidates[0];
    if (!definition) throw new RpcError("LSP_UNAVAILABLE", `No enabled language server matches ${languageIdForPath(relative)}`);
    if (!definition.executable && !serverCatalog.some(preset => preset.id === definition.id)) throw new RpcError("INVALID_PARAMS", "Custom language servers require an executable");
    const root = await this.projectRoot(relative, definition.rootMarkers);
    const digest = fingerprint({ definition, associations }), id = `${definition.id}:${fingerprint([root, digest]).slice(0, 24)}`;
    let instance = this.instances.get(id);
    if (!instance) {
      const server = new LanguageServer(this.files, (method, params) => this.emit(method, params, id), {
        name: definition.name, root,
        prepare: async signal => {
          let spec: LaunchSpec;
          const override = definition.executable ?? (definition.id === "typescript" ? setting("LSP_COMMAND") : undefined);
          if (override) spec = { executable: override, args: definition.args ?? ["--stdio"] };
          else spec = await resolveLaunch(definition.id, root, this.installer, signal);
          return { ...spec, args: definition.args ?? spec.args, env: { ...spec.env, ...definition.env }, initializationOptions: merge(spec.initializationOptions, definition.initializationOptions), settings: merge(spec.settings, definition.settings) };
        },
      });
      instance = { id, definition, root, fingerprint: digest, server, attachments: new Map(), associations, queue: Promise.resolve(), lifecycle: 0 };
      this.instances.set(id, instance);
    }
    clearTimeout(instance.idle); instance.idle = undefined;
    const attached = instance.attachments.get(owner) ?? new Set<string>();
    attached.add(relative); instance.attachments.set(owner, attached);
    const canonical = this.canonicalDocuments.get(relative);
    if (canonical !== undefined) instance.server.canonical(relative, canonical, resolveLanguage(relative, { associations, firstLine: canonical.split("\n", 1)[0] }).id);
    return { instanceId: id, ...instance.server.status() };
  }
  detach(owner: string, relative?: string, instanceId?: string) {
    for (const instance of this.instances.values()) {
      if (instanceId && instanceId !== instance.id) continue;
      const paths = instance.attachments.get(owner);
      if (!paths) continue;
      const removed = relative ? paths.has(relative) ? [relative] : [] : [...paths];
      if (relative) paths.delete(relative); else paths.clear();
      if (!paths.size) instance.attachments.delete(owner);
      for (const file of removed) if (![...instance.attachments.values()].some(paths => paths.has(file))) {
        instance.server.closeDocument(file);
      }
      if (!instance.attachments.size && !instance.idle) {
        instance.idle = setTimeout(() => { instance.idle = undefined; void this.stop(false, instance.id); }, this.idleMs);
        instance.idle.unref();
      }
    }
  }
  isAttached(owner: string, id: string) { return this.instances.get(id)?.attachments.has(owner) ?? false; }
  canonical(relative: string, text: string) {
    this.canonicalDocuments.set(relative, text);
    // Legacy callers continue to use the default TypeScript stream.
    if (["typescript", "tsx", "javascript", "json"].includes(languageIdForPath(relative))) this.defaultServer.canonical(relative, text);
    for (const instance of this.instances.values()) if ([...instance.attachments.values()].some(paths => paths.has(relative))) instance.server.canonical(relative, text, resolveLanguage(relative, { associations: instance.associations, firstLine: text.split("\n", 1)[0] }).id);
  }
  closeCanonical(relative: string) {
    this.canonicalDocuments.delete(relative); this.defaultServer.closeCanonical(relative);
    for (const instance of this.instances.values()) instance.server.closeCanonical(relative);
  }
  saved(relative: string, text: string) {
    this.defaultServer.saved(relative, text);
    for (const instance of this.instances.values()) instance.server.saved(relative, text);
  }
  async watched(relative: string, type: number) {
    await Promise.all([this.defaultServer.watched(relative, type), ...[...this.instances.values()].map(instance => instance.server.watched(relative, type))]);
  }
  authorizeExternal(uri: string, id?: string) { return this.get(id).external.authorize(uri); }
  readExternal(handle: string, id?: string) { return this.get(id).external.read(handle); }
  respond(requestId: number, result: unknown, id?: string) { this.get(id).respond(requestId, result); }
  status(id?: string) { return this.get(id).status(); }
  list() { return [...this.instances.values()].map(instance => ({ ...instance.server.status(), instanceId: instance.id, definitionId: instance.definition.id, fingerprint: instance.fingerprint })); }
  versions(id?: string) { return this.get(id).versions(); }
  start(resume = false, id?: string) {
    const instance = id ? this.instances.get(id) : undefined, lifecycle = instance?.lifecycle ?? this.defaultLifecycle;
    return this.serialize(id, () => { if (lifecycle !== (instance?.lifecycle ?? this.defaultLifecycle)) throw new RpcError("LSP_STOPPED", "A newer lifecycle action cancelled this start"); return this.get(id).start(resume); });
  }
  restart(id?: string) { this.get(id).cancelStart(); return this.serialize(id, () => this.get(id).restart()); }
  stop(pause = false, id?: string) {
    const instance = id ? this.instances.get(id) : undefined;
    if (instance) instance.lifecycle++; else this.defaultLifecycle++;
    this.get(id).cancelStart(); return this.serialize(id, () => this.get(id).stop(pause));
  }
  request(method: string, params: unknown, signal?: AbortSignal, applyEdit?: Parameters<LanguageServer["request"]>[3], id?: string) { return this.get(id).request(method, params, signal, applyEdit); }
  notify(method: string, params: any, id?: string) { return this.get(id).notify(method, params); }
  async suspend() {
    for (const instance of this.instances.values()) instance.server.cancelStart();
    await Promise.all([this.defaultServer.stop(), ...[...this.instances.values()].map(instance => this.stop(false, instance.id))]);
  }
  async dispose() {
    for (const instance of this.instances.values()) { clearTimeout(instance.idle); instance.server.cancelStart(); }
    await Promise.all([this.defaultServer.stop(), ...[...this.instances.values()].map(instance => this.stop(false, instance.id))]);
    this.instances.clear();
  }
  pathForUri(uri: string) { return path.relative(this.files.root, fileURLToPath(uri)); }
}
