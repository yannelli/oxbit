import { settingsChanges, settingsLayers, settingsFile, settingsObject, parseSettings, type SettingsChange, type SettingsLayers, type SettingsSnapshot, type FileSystem, type Kernel, type Persistence, type RpcClient } from "@oxbit/sdk";

interface Recovery { snapshot: SettingsSnapshot; local: SettingsLayers; pending: SettingsChange[] }
const empty = () => settingsLayers({}, {});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Mirrors the runtime patch check: the change's scope has an invalid file, or disk matches neither side of the change. */
const conflicting = (latest: SettingsSnapshot, change: SettingsChange) => {
  const existing = change.path.reduce<unknown>((value, key) => settingsObject(value) ? value[key] : undefined, settingsFile(latest.layers, change.scope));
  return latest.files.some(file => file.scope === change.scope && file.error) || (!same(existing, change.before) && !same(existing, change.value));
};
/** Applies changes over the latest layers; each rebased change records the disk value it replaces. */
function rebase(layers: SettingsLayers, changes: SettingsChange[]) {
  const files = { user: settingsFile(layers, "user"), workspace: settingsFile(layers, "workspace") };
  const rebased = changes.map(change => {
    let cursor = files[change.scope];
    for (const key of change.path.slice(0, -1)) { if (!settingsObject(cursor[key])) cursor[key] = {}; cursor = cursor[key] as Record<string, unknown>; }
    const key = change.path.at(-1)!, before = cursor[key];
    if (change.value === undefined) delete cursor[key]; else cursor[key] = change.value;
    return { scope: change.scope, path: change.path, ...(before === undefined ? {} : { before }), ...(change.value === undefined ? {} : { value: change.value }) };
  });
  return { layers: settingsLayers(files.user, files.workspace), changes: rebased };
}

/** Copies User setting changes from a runtime session into the storage profile that sessions without a runtime read. */
export function mirrorUserChanges(kernel: Kernel, storage: Persistence, notify: (message: string, type?: string) => void) {
  let previous = kernel.configuration.export() as SettingsLayers, queue = Promise.resolve();
  return kernel.configuration.subscribe(() => {
    const current = kernel.configuration.export() as SettingsLayers;
    const changes = settingsChanges(previous, current).filter(change => change.scope === "user");
    previous = current;
    if (changes.length) queue = queue.then(async () => {
      const { layers } = rebase({ ...empty(), ...await storage.get<Pick<SettingsLayers, "user" | "userLanguages">>("profile-settings") }, changes);
      await storage.set("profile-settings", { user: layers.user, userLanguages: layers.userLanguages });
    }).catch(error => notify(error instanceof Error ? error.message : String(error), "error"));
  });
}

/** Browser-only sessions use host storage; runtime sessions share the same JSON files. */
export class ScopedConfigurationPersistence implements Persistence {
  readonly key: string;
  private readonly recoveryKey: string;
  private loaded?: Promise<SettingsLayers>;
  private snapshot?: SettingsSnapshot;
  private local = empty();
  private pending: SettingsChange[] = [];
  private queue: Promise<void> = Promise.resolve();
  private kernel?: Kernel;
  private notify?: (message: string, type?: string) => void;
  private errors: string[] = [];
  private reported = new Set<string>();
  private subscriptions: (() => void)[] = [];
  private disposed = false;
  private fileSettings: boolean;
  constructor(private storage: Persistence, private filesystem: FileSystem, private runtime?: RpcClient) {
    this.key = "workspace-settings:" + filesystem.id;
    this.recoveryKey = this.key + ":files";
    this.fileSettings = !!runtime && (runtime as RpcClient & { session?: { owner: boolean } }).session?.owner !== false;
  }
  async get<T>(key: string): Promise<T | undefined> {
    if (key !== "settings") return this.storage.get<T>(key);
    this.loaded ??= this.load();
    return structuredClone(await this.loaded) as T;
  }
  private async load(): Promise<SettingsLayers> {
    const legacy = await this.storage.get<SettingsLayers>("settings"), profile = await this.storage.get<Pick<SettingsLayers, "user" | "userLanguages">>("profile-settings");
    const workspace = await this.storage.get<Pick<SettingsLayers, "workspace" | "workspaceLanguages">>(this.key);
    this.local = { ...empty(), ...legacy, ...profile, ...workspace };
    if (!this.fileSettings) return this.local;
    const recovery = await this.storage.get<Recovery>(this.recoveryKey);
    let seed = structuredClone(this.local);
    if (recovery) { this.snapshot = recovery.snapshot; this.local = recovery.local; this.pending = recovery.pending; }
    else {
      const old = await this.storage.get<{ value: Pick<SettingsLayers, "workspace" | "workspaceLanguages">; lastText?: string }>(this.key + ":pending");
      if (old) {
        const saved = settingsLayers({}, old.lastText ? parseSettings(JSON.parse(old.lastText)) : {});
        seed = { ...seed, workspace: saved.workspace, workspaceLanguages: saved.workspaceLanguages };
        this.local = { ...this.local, ...old.value };
        this.pending = settingsChanges(seed, this.local);
      }
      this.snapshot = { layers: seed, files: [] };
    }
    try {
      const snapshot = await this.runtime!.request<SettingsSnapshot>("settings.read", { legacy: recovery?.snapshot.layers ?? seed });
      this.snapshot = snapshot;
      if (!this.pending.length) this.local = snapshot.layers;
      this.reportFiles(snapshot);
      await this.flush();
      await this.cache();
    } catch (error) { this.report(`Settings are retained locally: ${reason(error)}`, reason(error)); }
    await this.cache();
    return this.local;
  }
  async set(key: string, value: unknown) {
    if (key !== "settings") return this.storage.set(key, value);
    const layers = structuredClone(value) as SettingsLayers;
    if (!this.fileSettings) {
      this.local = layers;
      await this.storage.set("profile-settings", { user: layers.user, userLanguages: layers.userLanguages });
      await this.storage.set(this.key, { workspace: layers.workspace, workspaceLanguages: layers.workspaceLanguages });
      return;
    }
    const changes = settingsChanges(this.local, layers);
    this.local = layers;
    this.pending.push(...changes);
    if (this.snapshot && !settingsChanges(this.snapshot.layers, this.local).length) this.pending = [];
    this.queue = this.queue.catch(() => {}).then(async () => {
      await this.cache();
      try { await this.flush(); } catch (error) { this.report(`Settings are retained locally: ${reason(error)}`, reason(error)); }
    });
    await this.queue;
  }
  private async cache() {
    if (this.snapshot) {
      await this.storage.set(this.recoveryKey, { snapshot: this.snapshot, local: this.local, pending: this.pending } satisfies Recovery);
      await this.storage.delete(this.key + ":pending");
    }
  }
  private async flush() {
    if (!this.pending.length || this.disposed) return;
    if (!this.runtime?.connected) throw new Error("Reconnect to save settings to disk.");
    if (!this.snapshot?.files.length) this.snapshot = await this.runtime.request<SettingsSnapshot>("settings.read", { legacy: this.snapshot?.layers ?? empty() });
    const changes = [...this.pending], saved = structuredClone(this.local);
    let snapshot: SettingsSnapshot, held: SettingsChange[] = [], failure: unknown;
    try { snapshot = await this.runtime.request<SettingsSnapshot>("settings.patch", { changes }); }
    catch (error) {
      // The runtime rejects the whole batch, so hold only the conflicting changes and save the rest.
      if ((error as { code?: string }).code !== "CONFLICT") throw error;
      const latest = await this.runtime.request<SettingsSnapshot>("settings.read");
      held = changes.filter(change => conflicting(latest, change));
      if (!held.length) throw error;
      const clean = changes.filter(change => !held.includes(change));
      snapshot = clean.length ? await this.runtime.request<SettingsSnapshot>("settings.patch", { changes: clean }) : latest;
      failure = error;
    }
    this.pending.splice(0, changes.length, ...held);
    this.snapshot = snapshot;
    // A newer UI change can already be queued in the kernel. Do not replace it.
    if (this.pending.length === held.length && (!this.kernel || !settingsChanges(saved, this.kernel.configuration.export() as SettingsLayers).length)) this.apply(snapshot, held);
    await this.cache();
    if (failure) throw failure;
  }
  private apply(snapshot: SettingsSnapshot, held: SettingsChange[] = []) {
    this.snapshot = snapshot;
    this.local = held.length ? rebase(snapshot.layers, held).layers : structuredClone(snapshot.layers);
    this.kernel?.configuration.import(this.local, { persist: false });
    this.reportFiles(snapshot);
    if (!this.pending.length && !snapshot.files.some(file => file.error)) this.reported.clear();
  }
  private reportFiles(snapshot: SettingsSnapshot) {
    for (const file of snapshot.files) if (file.error) this.report(`${file.path}: ${file.error}. Keeping the last valid settings.`);
  }
  /** Reports each distinct failure once until settings save and load cleanly again. */
  private report(message: string, key = message) {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    if (this.notify) this.notify(message, "error");
    else this.errors.push(message);
  }
  attach(kernel: Kernel, notify: (message: string, type?: string) => void) {
    this.kernel = kernel; this.notify = notify;
    for (const message of this.errors) notify(message, "error");
    this.errors = [];
    if (!this.fileSettings) return;
    const refresh = () => {
      this.queue = this.queue.catch(() => {}).then(async () => {
        if (this.disposed) return;
        try {
          await this.flush();
          if (this.pending.length || settingsChanges(this.local, kernel.configuration.export() as SettingsLayers).length) return;
          this.apply(await this.runtime!.request<SettingsSnapshot>("settings.read"));
          await this.cache();
        } catch (error) { this.report(`Settings reload failed: ${reason(error)}`, reason(error)); }
      });
    };
    this.subscriptions.push(this.runtime!.subscribe("settings.changed", refresh));
    this.subscriptions.push(this.runtime!.subscribe("connection.change", event => { if (event.state === "connected") refresh(); }));
  }
  async resolveWorkspaceSettings(choice: "disk" | "local") {
    if (!this.runtime?.connected || !this.kernel || !this.fileSettings) throw new Error("Connect to the workspace owner runtime first");
    await this.queue;
    const latest = await this.runtime.request<SettingsSnapshot>("settings.read");
    if (choice === "disk") {
      this.pending = [];
      this.apply(latest);
    } else {
      this.pending = rebase(latest.layers, this.pending).changes;
      if (this.pending.length) await this.flush(); else this.apply(latest);
    }
    await this.cache();
  }
  async delete(key: string) {
    if (key === "settings") await this.set(key, empty());
    else await this.storage.delete(key);
  }
  async dispose() { this.disposed = true; for (const off of this.subscriptions) off(); await this.queue.catch(() => {}); }
}
