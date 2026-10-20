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
/** A remote access host advertised over Bonjour as `_oxbit-remote._tcp`; pairing needs a link from it. */
export interface DiscoveredRemoteHost {
  hostId: string;
  name: string;
  version?: string;
  host: string;
  port: number;
}
export const DISCOVERY_POLL_MS = 2000;

/** `localNetworkDenied` is true while iOS denies Oxbit Local Network access. */
interface DiscoveryList { runtimes: DiscoveredRuntime[]; hosts?: DiscoveredRemoteHost[]; localNetworkDenied?: boolean }
const request = (operation: "start" | "list" | "stop") =>
  invoke<DiscoveryList>("plugin:oxbit-files|runtime_discovery", { request: { operation } });

function unique<T>(items: T[], id: (item: T) => string): T[] {
  const byId = new Map<string, T>();
  for (const item of items) if (!byId.has(id(item))) byId.set(id(item), item);
  return [...byId.values()];
}

/** `host:port` for a WebSocket URL, with brackets around an IPv6 address. */
export function remoteHostAddress(host: Pick<DiscoveredRemoteHost, "host" | "port">): string {
  return host.host.includes(":") ? `[${host.host}]:${host.port}` : `${host.host}:${host.port}`;
}

/** Native browsing stops two minutes after the last `start` or `list`, so watching polls `list`. `hosts` lists `_oxbit-remote._tcp` services apart from runtimes. */
export const discovery = {
  watch(listener: (runtimes: DiscoveredRuntime[], localNetworkDenied: boolean, hosts: DiscoveredRemoteHost[]) => void): () => void {
    let active = true;
    let last: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deliver = ({ runtimes, hosts, localNetworkDenied }: DiscoveryList) => {
      if (!active) return;
      const next = unique(Array.isArray(runtimes) ? runtimes : [], (runtime) => runtime.runtimeId);
      const remote = unique(Array.isArray(hosts) ? hosts : [], (host) => host.hostId);
      const denied = localNetworkDenied === true;
      const key = JSON.stringify([next, denied, remote]);
      if (key === last) return;
      last = key;
      listener(next, denied, remote);
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
