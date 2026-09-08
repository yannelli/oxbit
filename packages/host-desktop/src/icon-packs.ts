import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Pack, PackStore } from "@oxbit/icon-themes";
/** Native application data store, shared by all projects and windows. */
export class DesktopIconPackStore implements PackStore {
  private listeners = new Set<() => void>();
  private unlisten = listen('icon-packs-changed', () => { for (const fn of this.listeners) fn(); });
  read() { return invoke<Pack[]>('desktop_icon_packs_read'); }
  private mutate(operation: string, id: string, pack?: Pack, enabled?: boolean) { return invoke<void>('desktop_icon_packs_mutate', { operation, id, pack, enabled }); }
  put(pack: Pack) { return this.mutate('put', pack.id, pack); }
  remove(id: string) { return this.mutate('remove', id); }
  enable(id: string, enabled: boolean) { return this.mutate('enable', id, undefined, enabled); }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  dispose() { this.listeners.clear(); void this.unlisten.then(fn => fn()); }
}
