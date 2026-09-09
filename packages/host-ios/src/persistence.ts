import type { Persistence } from "@oxbit/sdk";
import { native } from "./native.js";

export const PROFILE_SCOPE = "profile";
export const SESSION_SCOPE = "session";

/** Native JSON files: `profile.json` for user settings, `workspaces/<id>/ui.json` for the rest. */
export class IosPersistence implements Persistence {
  private queue = Promise.resolve();
  constructor(readonly scope: string) {}
  private scopeFor(key: string) {
    return key === "profile-settings" ? PROFILE_SCOPE : this.scope;
  }
  async get<T>(key: string): Promise<T | undefined> {
    return (await native.storageGet<T>(this.scopeFor(key), key)) ?? undefined;
  }
  set(key: string, value: unknown): Promise<void> {
    return this.enqueue(() => native.storageSet(this.scopeFor(key), key, value));
  }
  delete(key: string): Promise<void> {
    return this.enqueue(() => native.storageSet(this.scopeFor(key), key, null));
  }
  flush() {
    return this.queue;
  }
  private enqueue(operation: () => Promise<void>) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
}
