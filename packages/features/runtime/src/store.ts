import { splitRuntimeError, type RuntimeIdentity } from "@oxbit/protocol";
import type { RuntimeConnector, RuntimeStatus } from "@oxbit/workbench";

/** Observable connection status an app keeps across workbench sessions. */
export class RuntimeStatusStore {
  private listeners = new Set<() => void>();
  private value: RuntimeStatus = { state: "disconnected" };
  get = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  set(patch: Partial<RuntimeStatus>) {
    this.value = { ...this.value, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
  replace(next: RuntimeStatus) {
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  progress(message: string) {
    this.set({ state: "connecting", progress: message });
  }
  fail(error: unknown) {
    const { message, detail } = splitRuntimeError(error instanceof Error ? error.message : String(error));
    this.set({ state: "failed", progress: undefined, error: { message, detail, at: Date.now() } });
  }
}

/** The parts of RuntimeClient the page reads; structural so apps can pass any client. */
export interface RuntimeClientLike {
  url: string;
  connected: boolean;
  identity?: RuntimeIdentity;
  session?: { trusted: boolean; owner: boolean; workspaceName?: string };
}

export function clientStatus(client: RuntimeClientLike, kind: RuntimeStatus["kind"], name?: string): Partial<RuntimeStatus> {
  let url: URL | undefined;
  try { url = new URL(client.url); } catch { url = undefined; }
  return {
    kind,
    url: client.url,
    host: url?.hostname,
    port: url ? Number(url.port || (url.protocol === "https:" ? 443 : 80)) : undefined,
    name: client.identity?.name ?? name ?? url?.hostname,
    version: client.identity?.version,
    startedAt: client.identity?.startedAt,
    runtimeId: client.identity?.id,
    workspace: client.session?.workspaceName,
    trusted: client.session?.trusted,
    owner: client.session?.owner,
  };
}

/** Cloud button: open the page when connected or nothing is known; otherwise connect, opening the page on failure. */
export async function oneTap(connector: RuntimeConnector | undefined, open: () => void) {
  const status = connector?.status();
  const target = connector?.quickTarget();
  if (!connector || !target || status?.state === "connected" || status?.state === "connecting") {
    open();
    return;
  }
  try {
    await connector.connect(target);
  } catch {
    open();
  }
}

export function formatUptime(startedAt: number | undefined, now = Date.now()) {
  if (!startedAt || startedAt > now) return undefined;
  const minutes = Math.floor((now - startedAt) / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`;
}
