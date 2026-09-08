import { ThemePackStore } from "@oxbit/themes";
import { bundledPacks } from "./bundled.js";
let store: ThemePackStore | undefined;
export function profilePacks() {
  if (store) return store;
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("oxbit-theme-packs", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("profile");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const operation = async <T>(
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T>,
  ) => {
    const db = await database;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("profile", mode);
      const req = run(tx.objectStore("profile"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("oxbit-theme-packs")
      : undefined;
  store = new ThemePackStore(
    {
      get: <T>(key: string) =>
        operation<T | undefined>("readonly", (s) => s.get(key)),
      set: async (key, value) => {
        await operation("readwrite", (s) => s.put(value, key));
        channel?.postMessage("changed");
      },
      withLock: async (action) =>
        await (navigator.locks
          ? navigator.locks.request("oxbit-theme-packs", action)
          : action()),
    },
    new Set(bundledPacks.map((p) => p.id)),
  );
  if (channel)
    channel.onmessage = () => {
      void store
        ?.reload()
        .catch((error) => store?.diagnostics.push(String(error)));
    };
  return store;
}
