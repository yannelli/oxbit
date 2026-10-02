import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RpcClient, Unsubscribe } from "@oxbit/sdk";
import { native } from "./native.js";

export class IosGitClient implements RpcClient {
  private disposed = false;
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private subscription?: Promise<UnlistenFn>;
  private pending = new Map<string, Promise<unknown>>();
  constructor(readonly id: string) {}
  get connected() { return !this.disposed; }
  subscribe(event: string, listener: (params: any) => void): Unsubscribe {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(event);
    };
  }
  private emit(event: string, params: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(params);
  }
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, options?: { signal?: AbortSignal }): Promise<T> {
    if (this.disposed) throw new Error("The Git workspace is closed.");
    if (!method.startsWith("git.")) throw new Error("The native Git client accepts Git requests.");
    options?.signal?.throwIfAborted();
    this.subscription ??= listen<{ requestId: string; data: string }>(`ios-git-progress:${this.id}`, ({ payload }) => {
      if (this.pending.has(payload.requestId)) this.emit("git.progress", { data: payload.data });
    }).catch(error => {
      this.subscription = undefined;
      throw error;
    });
    await this.subscription;
    if (this.disposed) throw new Error("The Git workspace is closed.");
    options?.signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void native.gitCancel(this.id, requestId).catch(error => this.emit("git.progress", { message: String(error) }));
    };
    options?.signal?.addEventListener("abort", cancel, { once: true });
    const operation = native.gitRequest<T>(this.id, requestId, method.slice(4), params);
    this.pending.set(requestId, operation);
    try {
      const result = await operation;
      if (!["status", "diff", "log", "show", "commitDiff", "stashes", "stashDiff"].includes(method.slice(4)))
        this.emit("fs.change", {});
      return result;
    } finally {
      options?.signal?.removeEventListener("abort", cancel);
      this.pending.delete(requestId);
    }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.pending.keys()].map(requestId => native.gitCancel(this.id, requestId)));
    await Promise.allSettled([...this.pending.values()]);
    if (this.subscription) (await this.subscription)();
    this.listeners.clear();
  }
}
