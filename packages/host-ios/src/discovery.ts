import { invoke } from "@tauri-apps/api/core";

/** An Oxbit runtime advertised over Bonjour as `_oxbit._tcp` on the local network. */
export interface DiscoveredRuntime {
  runtimeId: string;
  name: string;
  version?: string;
  host: string;
  port: number;
  url: string;
}
export const DISCOVERY_POLL_MS = 2000;

/** `localNetworkDenied` is true while iOS denies Oxbit Local Network access. */
interface DiscoveryList { runtimes: DiscoveredRuntime[]; localNetworkDenied?: boolean }
const request = (operation: "start" | "list" | "stop") =>
  invoke<DiscoveryList>("plugin:oxbit-files|runtime_discovery", { request: { operation } });

function unique(runtimes: DiscoveredRuntime[]): DiscoveredRuntime[] {
  const byId = new Map<string, DiscoveredRuntime>();
  for (const runtime of runtimes) if (!byId.has(runtime.runtimeId)) byId.set(runtime.runtimeId, runtime);
  return [...byId.values()];
}

/** Native browsing stops two minutes after the last `start` or `list`, so watching polls `list`. */
export const discovery = {
  watch(listener: (runtimes: DiscoveredRuntime[], localNetworkDenied: boolean) => void): () => void {
    let active = true;
    let last: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deliver = ({ runtimes, localNetworkDenied }: DiscoveryList) => {
      if (!active) return;
      const next = unique(Array.isArray(runtimes) ? runtimes : []);
      const denied = localNetworkDenied === true;
      const key = JSON.stringify([next, denied]);
      if (key === last) return;
      last = key;
      listener(next, denied);
    };
    const poll = () => {
      timer = setTimeout(() => {
        void request("list").then(deliver, () => undefined).finally(() => {
          if (active) poll();
        });
      }, DISCOVERY_POLL_MS);
    };
    void request("start").then(
      (result) => {
        deliver(result);
        if (active) poll();
      },
      () => undefined,
    );
    return () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      void request("stop").catch(() => undefined);
    };
  },
};
