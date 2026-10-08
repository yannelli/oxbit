import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RpcClient, Unsubscribe } from "@oxbit/sdk";
import { native } from "./native.js";

/** Errors from Git over SSH that the app answers with a prompt before the request runs again. */
export const SSH_PROMPT_CODES = new Set(["HOST_KEY_UNKNOWN", "HOST_KEY_CHANGED", "SSH_KEY_REQUIRED"]);
const MAX_PROMPTS = 3;
/** Shows the prompt left for the root; resolves `true` to run the request again. */
export type SshGitPromptHandler = (rootId: string) => Promise<boolean>;

export class IosGitClient implements RpcClient {
  static sshPrompt?: SshGitPromptHandler;
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
    for (let prompts = 0; ; prompts++) {
      try {
        const result = await this.send<T>(method.slice(4), params, options?.signal);
        if (!["status", "diff", "log", "show", "commitDiff", "stashes", "stashDiff"].includes(method.slice(4)))
          this.emit("fs.change", {});
        return result;
      } catch (failure) {
        const code = (failure as { code?: string }).code ?? "";
        const prompt = IosGitClient.sshPrompt;
        if (prompts >= MAX_PROMPTS || !SSH_PROMPT_CODES.has(code) || !prompt || this.disposed || options?.signal?.aborted ||
          !(await prompt(this.id))) throw failure;
      }
    }
  }
  private async send<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void native.gitCancel(this.id, requestId).catch(error => this.emit("git.progress", { message: String(error) }));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const operation = native.gitRequest<T>(this.id, requestId, method, params);
    this.pending.set(requestId, operation);
    try {
      return await operation;
    } finally {
      signal?.removeEventListener("abort", cancel);
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
