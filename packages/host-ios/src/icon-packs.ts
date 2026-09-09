import { listen } from "@tauri-apps/api/event";
import type { Pack, PackStore } from "@oxbit/icon-themes";
import { native } from "./native.js";
/** Native application data store shared by every workspace. */
export class IosIconPackStore implements PackStore {
  private listeners = new Set<() => void>();
  private unlisten = listen("icon-packs-changed", () => { for (const fn of this.listeners) fn(); });
  read() { return native.iconPacksRead<Pack>(); }
  put(pack: Pack) { return native.iconPacksMutate("put", pack.id, pack); }
  remove(id: string) { return native.iconPacksMutate("remove", id); }
  enable(id: string, enabled: boolean) { return native.iconPacksMutate("enable", id, undefined, enabled); }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  dispose() { this.listeners.clear(); void this.unlisten.then(fn => fn()); }
}
