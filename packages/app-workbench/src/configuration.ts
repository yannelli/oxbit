import { settingsChanges, settingsLayers, settingsFile, settingsObject, parseSettings, type SettingsChange, type SettingsLayers, type SettingsSnapshot, type FileSystem, type Kernel, type Persistence, type RpcClient } from "@oxbit/sdk";

interface Recovery { snapshot: SettingsSnapshot; local: SettingsLayers; pending: SettingsChange[] }
const empty = () => settingsLayers({}, {});

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
    } catch (error) { this.report(`Settings are retained locally: ${String(error)}`); }
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
      try { await this.flush(); } catch (error) { this.report(`Settings are retained locally: ${String(error)}`); }
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
    const snapshot = await this.runtime.request<SettingsSnapshot>("settings.patch", { changes });
    this.pending.splice(0, changes.length);
    this.snapshot = snapshot;
    // A newer UI change can already be queued in the kernel. Do not replace it.
    if (!this.pending.length && (!this.kernel || !settingsChanges(saved, this.kernel.configuration.export() as SettingsLayers).length)) this.apply(snapshot);
    await this.cache();
  }
  private apply(snapshot: SettingsSnapshot) {
    this.snapshot = snapshot;
    this.local = structuredClone(snapshot.layers);
    this.kernel?.configuration.import(this.local, { persist: false });
    this.reportFiles(snapshot);
  }
  private reportFiles(snapshot: SettingsSnapshot) {
    for (const file of snapshot.files) if (file.error) this.report(`${file.path}: ${file.error}. Keeping the last valid settings.`);
  }
  private report(message: string) {
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
        } catch (error) { this.report(`Settings reload failed: ${String(error)}`); }
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
      const files = { user: settingsFile(latest.layers, "user"), workspace: settingsFile(latest.layers, "workspace") };
      this.pending = this.pending.map(change => {
        let cursor = files[change.scope];
        for (const key of change.path.slice(0, -1)) { if (!settingsObject(cursor[key])) cursor[key] = {}; cursor = cursor[key] as Record<string, unknown>; }
        const key = change.path.at(-1)!, before = cursor[key];
        if (change.value === undefined) delete cursor[key]; else cursor[key] = change.value;
        return { scope: change.scope, path: change.path, ...(before === undefined ? {} : { before }), ...(change.value === undefined ? {} : { value: change.value }) };
      });
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
