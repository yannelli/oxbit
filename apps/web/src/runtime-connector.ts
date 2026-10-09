import { translate as tr } from "@oxbit/ui";
import type { Persistence } from "@oxbit/sdk";
import { RuntimeClient } from "@oxbit/host-runtime";
import { AUTO_RECONNECT_SETTING, RuntimeStatusStore, clientStatus } from "@oxbit/feature-runtime";
import type { RuntimeConnector, RuntimeTarget } from "@oxbit/workbench";
import type { Session } from "@oxbit/app-workbench";

const SAVED_KEY = "runtimes";
const LIMIT = 12;

export interface WebRuntimeHost {
  persistence: Persistence;
  /** Boots a workbench session on the client and makes it current. */
  open(runtime: RuntimeClient): Promise<void>;
}

export const targetKey = (url: string, runtimeId?: string) => runtimeId ? "url:" + runtimeId : "url:" + url;

/** Explains a failed connection with what the address actually answered. */
export async function describeFailure(url: string, error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (!/cannot connect|connection closed|timed out|failed to fetch/i.test(text)) return text;
  try {
    const health = await fetch(url + "/api/health", { signal: AbortSignal.timeout(4000) });
    if (!health.ok) return tr("{0} answered HTTP {1}; it is not an Oxbit runtime.", { 0: url, 1: health.status });
    return tr("The runtime at {0} is running but refused this browser. Pair it again with its pairing code.", { 0: url });
  } catch {
    // Another origin's health reply is unreadable without CORS, but an opaque reply still proves something listens.
    const reachable = await fetch(url + "/api/health", { mode: "no-cors", signal: AbortSignal.timeout(4000) }).then(() => true, () => false);
    return reachable
      ? tr("{0} is reachable but did not accept this page. Open Oxbit from the address the runtime prints, or pair it again.", { 0: url })
      : tr("No runtime answered at {0}. Start one with oxbit and check the address.", { 0: url });
  }
}

/** One per page load; workbench sessions come and go as runtimes are connected. */
export class WebRuntimeConnector implements RuntimeConnector {
  readonly store = new RuntimeStatusStore();
  readonly startCommand = "oxbit --no-open";
  private session?: Session;
  private detach: (() => void)[] = [];
  constructor(private readonly host: WebRuntimeHost) {}
  status = this.store.get;
  subscribe = this.store.subscribe;

  /** Follows the runtime of the session now on screen. */
  attach(session: Session) {
    for (const off of this.detach) off();
    this.session = session;
    const runtime = session.runtime;
    if (!runtime) {
      this.detach = [];
      this.store.replace({ state: "disconnected", error: this.store.get().error });
      return;
    }
    const sync = () => this.store.replace({
      state: runtime.connected ? "connected" : this.store.get().state === "failed" ? "failed" : "reconnecting",
      ...clientStatus(runtime, "url"), targetKey: targetKey(runtime.url, runtime.identity?.id),
    });
    const applySetting = () => { runtime.autoReconnect = session.kernel.configuration.get(AUTO_RECONNECT_SETTING) !== false; };
    applySetting();
    sync();
    this.detach = [
      runtime.subscribe("connection.change", ({ state }) => state === "disconnected" ? this.store.set({ state: "disconnected" }) : sync()),
      runtime.subscribe("workspace.trust", ({ trusted }) => this.store.set({ trusted: trusted === true })),
      session.kernel.configuration.subscribe(applySetting),
    ];
  }

  quickTarget(): RuntimeTarget | undefined {
    const runtime = this.session?.runtime;
    if (runtime) return { key: targetKey(runtime.url, runtime.identity?.id), kind: "url", name: runtime.identity?.name ?? new URL(runtime.url).host, url: runtime.url, runtimeId: runtime.identity?.id };
    return this.saved[0];
  }
  private saved: RuntimeTarget[] = [];
  async load() {
    const stored = await this.host.persistence.get<RuntimeTarget[]>(SAVED_KEY);
    const last = await this.host.persistence.get<{ url?: string; runtimeId?: string }>("last-host");
    this.saved = Array.isArray(stored) ? stored : [];
    if (!this.saved.length && last?.url)
      this.saved = [{ key: targetKey(last.url, last.runtimeId), kind: "url", name: new URL(last.url).host, url: last.url, runtimeId: last.runtimeId }];
    return this.saved;
  }
  recents = () => this.load();
  async forget(target: RuntimeTarget) {
    this.saved = (await this.load()).filter(item => item.key !== target.key && item.url !== target.url);
    await this.host.persistence.set(SAVED_KEY, this.saved);
  }
  private async remember(runtime: RuntimeClient) {
    const id = runtime.identity?.id;
    const entry: RuntimeTarget = {
      key: targetKey(runtime.url, id), kind: "url", runtimeId: id, url: runtime.url, lastConnected: Date.now(),
      name: runtime.identity?.name ?? new URL(runtime.url).host, detail: runtime.session?.workspaceName ? `${runtime.session.workspaceName} · ${runtime.url}` : runtime.url,
    };
    this.saved = [entry, ...(await this.load()).filter(item => item.key !== entry.key && item.url !== entry.url && (!id || item.runtimeId !== id))].slice(0, LIMIT);
    await this.host.persistence.set(SAVED_KEY, this.saved);
    await this.host.persistence.set("last-host", { url: runtime.url, runtimeId: id });
  }

  private async establish(url: string, label: string, start: (runtime: RuntimeClient) => Promise<void>, runtimeId?: string) {
    this.store.replace({ ...this.store.get(), state: "connecting", progress: tr("Connecting to {0}…", { 0: label }), error: undefined });
    const runtime = new RuntimeClient(url.replace(/\/$/, ""), "default", { runtimeId });
    try {
      await start(runtime);
      this.store.progress(tr("Opening the workspace…"));
      await this.host.open(runtime);
      await this.remember(runtime);
    } catch (error) {
      runtime.dispose();
      this.store.fail(await describeFailure(runtime.url, error));
      throw error;
    }
  }
  connect(target: RuntimeTarget) {
    if (!target.url) return Promise.reject(new Error(tr("This runtime has no address. Pair it again.")));
    return this.establish(target.url, target.name, runtime => runtime.connect(), target.runtimeId);
  }
  pair(url: string, code: string) {
    let address: URL;
    try { address = new URL(url); } catch { return Promise.reject(new Error(tr("Enter the runtime's http:// or https:// address."))); }
    return this.establish(address.origin, address.host, async runtime => {
      await runtime.pair(code);
      await runtime.connect();
    });
  }
  async disconnect() {
    this.session?.runtime?.disconnect();
    this.store.set({ state: "disconnected", progress: undefined });
    this.session?.workbench.touch();
  }
  async trust(trusted: boolean) {
    const runtime = this.session?.runtime;
    if (!runtime) return;
    await runtime.trust(trusted);
    this.store.set({ trusted: !!runtime.session?.trusted });
    this.session!.kernel.context.set("trusted", !!runtime.session?.trusted);
    this.session!.workbench.touch();
  }
}
