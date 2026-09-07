import type { Disposable, IconAsset, IconPackPreview, IconPackSummary, IconResource, IconThemeKind, IconThemes, IconVariant, Kernel } from "@oxbit/sdk";
import type { Pack, PackStore, StoredTheme } from "./types.js";
import { importPack } from "./import.js";
import { PackResources } from "./resources.js";
import { resolveDefinition } from "./resolver.js";
export { BrowserPackStore } from "./store.js";
export type { Pack, PackStore } from "./types.js";
export { importPack } from "./import.js";
export const iconSetting = (kind: IconThemeKind) => kind === 'fileIconTheme' ? 'workbench.iconTheme' : 'workbench.productIconTheme';
export class IconThemeService implements IconThemes {
  private packs: Pack[] = [];
  private resources = new Map<string, PackResources>();
  private previews = new Map<IconPackPreview, { pack: Pack; resources: PackResources }>();
  private listeners = new Set<() => void>();
  private registrations: Disposable[] = [];
  private lifetime: (() => void)[] = [];
  private version = 0;
  private generation = 0;
  private disposed = false;
  private notices = new Set<string>();
  constructor(private kernel: Kernel, private store: PackStore, private notify: (message: string) => void) {}
  async initialize() {
    this.lifetime.push(this.store.subscribe(() => { void this.refresh().catch(e => this.notice('storage', `Icon pack storage unavailable: ${String(e)}. Open Extensions → Icon Packs to retry.`)); }));
    this.lifetime.push(this.kernel.configuration.subscribe(() => { this.checkMissing(); this.emit(); }));
    await this.refresh();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private emit() { this.version++; for (const fn of this.listeners) fn(); }
  private notice(id: string, message: string) { if (!this.notices.has(id)) { this.notices.add(id); this.notify(message); } }
  private checkMissing() {
    const missing: string[] = [];
    for (const kind of ['fileIconTheme', 'productIconTheme'] as const) {
      const id = this.kernel.configuration.get<string>(iconSetting(kind));
      if (id && id !== 'oxbit.default' && !this.selected(kind)) missing.push(id);
    }
    if (missing.length) this.notice('missing', `Icon theme “${missing.join('”, “')}” is unavailable. Using Oxbit defaults; the selection is retained. Re-enable or reinstall it in Extensions → Icon Packs.`);
    else this.notices.delete('missing');
  }
  async refresh() {
    const generation = ++this.generation;
    const packs = await this.store.read(), next = new Map<string, PackResources>();
    for (const pack of packs) {
      if (!pack.enabled) continue;
      const old = this.resources.get(pack.id);
      if (old?.pack.revision === pack.revision) { next.set(pack.id, old); continue; }
      const resources = new PackResources(pack);
      try { await resources.load(); next.set(pack.id, resources); }
      catch { pack.warnings = [...pack.warnings, "Stored resources could not be validated. Replace this icon pack."]; }
    }
    if (this.disposed || generation !== this.generation) { for (const resource of next.values()) if (this.resources.get(resource.pack.id) !== resource) resource.dispose(); return; }
    for (const [id, old] of this.resources) if (next.get(id) !== old) old.dispose();
    this.resources = next; this.packs = packs;
    for (const registration of this.registrations) registration.dispose();
    this.registrations = [];
    for (const resource of next.values()) for (const theme of resource.pack.themes) this.registrations.push(this.kernel.contributions.register({ id: `${theme.kind}:${theme.id}`, kind: theme.kind, title: theme.label, data: { packId: resource.pack.id, revision: resource.pack.revision, themeId: theme.id } }));
    this.checkMissing(); this.emit();
  }
  list(): IconPackSummary[] { return this.packs.map(({ assets: _assets, formatVersion: _format, ...summary }) => ({ ...summary, themes: summary.themes.map(({ id, label, kind }) => ({ id, label, kind })) })); }
  samples(id: string): IconAsset[] {
    const resources = this.resources.get(id);
    return resources?.pack.themes.flatMap(theme => Object.keys(theme.data.iconDefinitions).slice(0, 6).map(id => resources.asset(theme, id))).filter((a): a is IconAsset => !!a) ?? [];
  }
  themes(kind: IconThemeKind) { return [...this.resources.values()].flatMap(p => p.pack.themes.filter(t => t.kind === kind).map(({ id, label, kind }) => ({ id, label, kind }))); }
  async preview(file: Blob, name: string, signal?: AbortSignal): Promise<IconPackPreview> {
    const pack = await importPack(file, name, signal), resources = new PackResources(pack);
    await resources.load(signal);
    if (this.disposed) { resources.dispose(); throw new Error('Session closed'); }
    const samples = pack.themes.flatMap(theme => Object.keys(theme.data.iconDefinitions).slice(0, 6).map(id => resources.asset(theme, id))).filter((a): a is IconAsset => !!a);
    const preview: IconPackPreview = { ...pack, themes: pack.themes.map(({ id, label, kind }) => ({ id, label, kind })), samples, dispose: () => { resources.dispose(); this.previews.delete(preview); } };
    this.previews.set(preview, { pack: structuredClone(pack), resources }); return preview;
  }
  async install(preview: IconPackPreview) {
    const item = this.previews.get(preview);
    if (!item || this.disposed) throw new Error('Import preview has expired');
    await this.store.put(item.pack);
    preview.dispose(); await this.refresh();
  }
  async enable(id: string, enabled: boolean) { await this.store.enable(id, enabled); await this.refresh(); }
  async remove(id: string) { await this.store.remove(id); await this.refresh(); }
  private selected(kind: IconThemeKind): { theme: StoredTheme; resources: PackResources } | undefined {
    const id = this.kernel.configuration.get<string>(iconSetting(kind));
    for (const resources of this.resources.values()) { const theme = resources.pack.themes.find(t => t.id === id && t.kind === kind); if (theme) return { theme, resources }; }
  }
  file(resource: IconResource, variant: IconVariant) {
    const selected = this.selected('fileIconTheme'); if (!selected) return;
    const id = resolveDefinition(selected.theme.data, resource, variant); return id ? selected.resources.asset(selected.theme, id) : undefined;
  }
  product(id: string) { const s = this.selected('productIconTheme'); return s?.resources.asset(s.theme, id); }
  hideArrows(resource: IconResource, variant: IconVariant) {
    const s = this.selected('fileIconTheme'); if (!s?.theme.data.hidesExplorerArrows) return false;
    const closed = resolveDefinition(s.theme.data, { ...resource, folder: true, expanded: false }, variant);
    const open = resolveDefinition(s.theme.data, { ...resource, folder: true, expanded: true }, variant);
    const a = closed && s.resources.asset(s.theme, closed), b = open && s.resources.asset(s.theme, open);
    return !!a && !!b && JSON.stringify(a) !== JSON.stringify(b);
  }
  dispose() {
    this.disposed = true; this.generation++;
    for (const cleanup of this.lifetime) cleanup();
    for (const registration of this.registrations) registration.dispose();
    for (const preview of [...this.previews.keys()]) preview.dispose();
    for (const resources of this.resources.values()) resources.dispose();
    this.resources.clear(); this.listeners.clear(); this.store.dispose();
  }
}
