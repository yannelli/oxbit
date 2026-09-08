import type { Pack, PackStore } from "./types.js";
interface Installed { id: string; revision: string; enabled: boolean }
const request = <T>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const complete = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Icon pack storage transaction failed')); });
/** A dedicated origin-wide database, independent of project and workspace storage. */
export class BrowserPackStore implements PackStore {
  private db: Promise<IDBDatabase>;
  private channel?: BroadcastChannel;
  private listeners = new Set<() => void>();
  constructor(name = 'oxbit-icon-packs-v1') {
    this.db = new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('revisions'); r.result.createObjectStore('installed', { keyPath: 'id' }); };
      r.onerror = () => reject(r.error);
      r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); resolve(r.result); };
      r.onblocked = () => reject(new Error('Close older Oxbit windows to upgrade icon pack storage'));
    });
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(name);
      this.channel.onmessage = () => this.emit();
    }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const fn of this.listeners) fn(); }
  private changed() { this.emit(); this.channel?.postMessage('changed'); }
  async read(): Promise<Pack[]> {
    const tx = (await this.db).transaction(['installed', 'revisions'], 'readonly'), done = complete(tx);
    const index = await request(tx.objectStore('installed').getAll()) as Installed[];
    const packs = await Promise.all(index.map(async item => {
      const pack = await request(tx.objectStore('revisions').get(item.revision)) as Pack | undefined;
      return pack ? { ...pack, enabled: item.enabled } : undefined;
    }));
    await done;
    return packs.filter((p): p is Pack => !!p);
  }
  private async mutate(id: string, pack?: Pack, enabled?: boolean) {
    const tx = (await this.db).transaction(['installed', 'revisions'], 'readwrite'), done = complete(tx);
    try {
      const index = tx.objectStore('installed'), revisions = tx.objectStore('revisions');
      const prior = await request(index.get(id)) as Installed | undefined;
      if (pack) {
        // Immutable revision write precedes the index switch in the same atomic transaction.
        await request(revisions.add(pack, pack.revision));
        await request(index.put({ id, revision: pack.revision, enabled: prior?.enabled ?? true }));
      } else if (enabled !== undefined) {
        if (prior) await request(index.put({ ...prior, enabled }));
      } else await request(index.delete(id));
      const installed = await request(index.getAll()) as Installed[];
      const used = new Set(installed.map(p => p.revision));
      for (const key of await request(revisions.getAllKeys())) if (!used.has(String(key))) await request(revisions.delete(key));
      await done;
      this.changed();
    } catch (error) { try { tx.abort(); } catch { /* already aborted */ } await done.catch(() => {}); throw error; }
  }
  put(pack: Pack) { return this.mutate(pack.id, pack); }
  remove(id: string) { return this.mutate(id); }
  enable(id: string, enabled: boolean) { return this.mutate(id, undefined, enabled); }
  dispose() { this.channel?.close(); this.listeners.clear(); void this.db.then(db => db.close()).catch(() => {}); }
}
