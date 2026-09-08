import { validateFont, isLicenseFile } from "./assets.js";
import {
  validatePack,
  resolveTheme,
  formatDiagnostics,
  safeAssetPath,
  type ThemePack,
  type ResolvedTheme,
} from "./index.js";
export interface InstalledPack {
  pack: ThemePack;
  assets: Record<string, Uint8Array>;
  enabled: boolean;
}
export interface PackPersistence {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  withLock?<T>(action: () => Promise<T>): Promise<T>;
}
interface StoredPacks {
  packs: InstalledPack[];
  modes: Record<string, "light" | "dark">;
}
function validateEntry(entry: InstalledPack) {
  const result = validatePack(entry.pack);
  if (!result.valid) throw new Error(formatDiagnostics(result.errors));
  let total = 0;
  for (const [path, bytes] of Object.entries(entry.assets)) {
    if (!safeAssetPath(path) || !(bytes instanceof Uint8Array))
      throw new Error(`${path}: Invalid asset`);
    if (!entry.pack.fonts?.some((f) => f.path === path) && !isLicenseFile(path))
      throw new Error(`${path}: Undeclared asset`);
    if (bytes.length > 20 * 1024 * 1024)
      throw new Error(`${path}: Asset exceeds 20 MB`);
    total += bytes.length;
  }
  if (total > 100 * 1024 * 1024 || Object.keys(entry.assets).length > 255)
    throw new Error("Pack asset limits exceeded");
  for (const font of entry.pack.fonts ?? []) {
    if (!entry.assets[font.path])
      throw new Error(`theme-pack.json /fonts: Missing ${font.path}`);
    validateFont(font.path, entry.assets[font.path]);
  }
}
/** Shared by sessions. Mutations are serialized and published only after durability. */
export class ThemePackStore {
  private packs: InstalledPack[] = [];
  private listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private revision = 0;
  private ready?: Promise<void>;
  private modes: StoredPacks["modes"] = {};
  readonly diagnostics: string[] = [];
  constructor(
    private storage: PackPersistence,
    private builtinIds: ReadonlySet<string> = new Set(),
  ) {}
  snapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  list = (includeAssets = true) =>
    structuredClone(
      includeAssets
        ? this.packs
        : this.packs.map((entry) => ({ ...entry, assets: {} })),
    );
  mode = (id: string) => {
    const mode = this.modes[id];
    return mode === "light" || mode === "dark" ? mode : undefined;
  };
  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  private async read() {
    const data = await this.storage.get<StoredPacks>("theme-packs.v1");
    const packs: InstalledPack[] = [];
    this.diagnostics.length = 0;
    for (const entry of data?.packs ?? [])
      try {
        validateEntry(entry);
        if (this.builtinIds.has(entry.pack.id))
          throw new Error("Reserved built-in pack ID");
        if (packs.some((p) => p.pack.id === entry.pack.id))
          throw new Error("Duplicate installed pack ID");
        packs.push(entry);
      } catch (error) {
        this.diagnostics.push(String(error));
      }
    return { packs, modes: data?.modes ?? {} };
  }
  load() {
    return (this.ready ??= this.read()
      .then((data) => {
        this.packs = data.packs;
        this.modes = data.modes;
        this.publish();
      })
      .catch((error) => {
        this.ready = undefined;
        throw error;
      }));
  }
  reload() {
    const next = this.queue.then(async () => {
      const data = await this.read();
      this.packs = data.packs;
      this.modes = data.modes;
      this.publish();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private mutate(change: (packs: InstalledPack[]) => InstalledPack[]) {
    const action = async () => {
      await this.load();
      const previous = await this.read();
      const packs = change(structuredClone(previous.packs));
      const modes = { ...previous.modes };
      for (const entry of packs)
        for (const t of entry.pack.themes)
          modes[`${entry.pack.id}/${t.id}`] = t.mode;
      await this.storage.set("theme-packs.v1", { packs, modes });
      this.packs = packs;
      this.modes = modes;
      this.publish();
    };
    const operation = this.queue.then(() =>
      this.storage.withLock ? this.storage.withLock(action) : action(),
    );
    this.queue = operation.catch(() => {});
    return operation;
  }
  install(pack: ThemePack, assets: Record<string, Uint8Array> = {}) {
    try {
      validateEntry({ pack, assets, enabled: true });
      if (this.builtinIds.has(pack.id))
        throw new Error("Built-in pack IDs cannot be replaced");
    } catch (error) {
      return Promise.reject(error);
    }
    const snapshot = structuredClone({ pack, assets });
    return this.mutate((packs) => [
      ...packs.filter((p) => p.pack.id !== pack.id),
      {
        ...snapshot,
        enabled: packs.find((p) => p.pack.id === pack.id)?.enabled ?? true,
      },
    ]);
  }
  remove(id: string) {
    return this.mutate((packs) => packs.filter((p) => p.pack.id !== id));
  }
  enable(id: string, enabled: boolean) {
    return this.mutate((packs) =>
      packs.map((p) => (p.pack.id === id ? { ...p, enabled } : p)),
    );
  }
  resolve(id: string): ResolvedTheme | undefined {
    for (const entry of this.packs)
      if (entry.enabled && id.startsWith(entry.pack.id + "/")) {
        const local = id.slice(entry.pack.id.length + 1);
        if (entry.pack.themes.some((t) => t.id === local))
          return resolveTheme(entry.pack, local);
      }
    return undefined;
  }
}
