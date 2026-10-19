import { RemoteHost, loadDeviceKey, readPairingLink, type PairedHost, type RemoteHostOptions, type RuntimeTarget } from "@oxbit/workbench";
import { SESSION_SCOPE, discovery, native, remoteDeviceKeyStore, remoteHostAddress, type DiscoveredRemoteHost } from "@oxbit/host-ios";
import type { KeyPair, Offer } from "@oxbit/sdk/tunnel";

export { readPairingLink };
const HOSTS_KEY = "remote-hosts";
/** Target keys of paired computers; a remote folder's key is its recent workspace id. */
export const COMPUTER_PREFIX = "computer:";

/** Returns `value` when it is an `oxbit://c#o=…` or `https://oxbit.dev/c#o=…` pairing link. */
export function openedPairingLink(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const custom = url.protocol === "oxbit:" && url.host === "c" && !url.pathname.replace(/\/$/, "");
  const web = url.protocol === "https:" && url.host === "oxbit.dev" && /^\/c\/?$/.test(url.pathname);
  return (custom || web) && new URLSearchParams(url.hash.slice(1)).has("o") ? value : undefined;
}

/** Calls `listener` with the newest pairing link the system opened the app with, now and while the app runs. */
export function watchOpenedLinks(listener: (link: string) => void): () => void {
  let active = true;
  const drain = () => void native.openedUrls().then(urls => {
    const link = urls.map(openedPairingLink).filter(Boolean).at(-1);
    if (active && link) listener(link);
  }, () => undefined);
  const unlisten = native.onOpenedUrl(drain).catch(() => undefined);
  void unlisten.then(drain);
  return () => {
    active = false;
    void unlisten.then(off => off?.());
  };
}

/** iPadOS web views report a Mac, so touch support tells an iPad apart. */
export function deviceName(agent = navigator.userAgent, touchPoints = navigator.maxTouchPoints) {
  return /iPad/.test(agent) || (/Macintosh/.test(agent) && touchPoints > 1) ? "iPad" : "iPhone";
}

/** The Runtime page and start screen entry for a paired computer. */
export function computerTarget(host: Pick<RemoteHost, "id" | "record" | "status">): RuntimeTarget {
  const { state, lastSeen, error } = host.status();
  return {
    key: COMPUTER_PREFIX + host.id, kind: "remote", name: host.record.name, hostId: host.id, lastSeen: lastSeen ?? host.record.lastSeen,
    online: state === "online" ? true : state === "offline" ? false : undefined,
    detail: state === "failed" ? error : undefined,
  };
}

/** Paired computers and their tunnels. Records live in app storage and the device key in the Keychain. */
export class RemoteHosts {
  /** Changes whenever the list or a host's status changes. */
  version = 0;
  private hosts: RemoteHost[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly bonjour = new Map<string, string[]>();
  private key?: Promise<KeyPair>;
  private loading?: Promise<void>;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  list = () => this.hosts;
  get(id: string) {
    return this.hosts.find(host => host.id === id);
  }

  /** Reads saved computers and starts connecting to each; the key loads only when a computer is saved. */
  load(): Promise<void> {
    return this.loading ??= (async () => {
      const stored = await native.storageGet<PairedHost[]>(SESSION_SCOPE, HOSTS_KEY).catch(() => null);
      if (!Array.isArray(stored) || !stored.length) return;
      const options = await this.options();
      this.replace(stored.map(record => this.watch(new RemoteHost(record, options))));
      for (const host of this.hosts) void host.connect().catch(() => undefined);
    })().catch(error => {
      this.loading = undefined;
      throw error;
    });
  }

  async pair(offer: Offer): Promise<RemoteHost> {
    await this.load().catch(() => undefined);
    const host = this.watch(await RemoteHost.pair(offer, await this.options()));
    this.get(host.id)?.dispose();
    this.replace([host, ...this.hosts.filter(item => item.id !== host.id)]);
    await this.persist();
    return host;
  }

  async forget(id: string) {
    this.get(id)?.dispose();
    this.replace(this.hosts.filter(host => host.id !== id));
    await this.persist();
  }

  /** Skips retry delays and checks live tunnels, for a return to the foreground. */
  reconnectAll() {
    for (const host of this.hosts) void host.reconnect().catch(() => undefined);
  }

  /** Bonjour addresses per host id from `_oxbit-remote._tcp`, tried first on the next connection. */
  setDiscovered(hosts: DiscoveredRemoteHost[]) {
    this.bonjour.clear();
    for (const host of hosts) this.bonjour.set(host.hostId, [...this.bonjour.get(host.hostId) ?? [], remoteHostAddress(host)]);
  }

  /** Browses the local network while a host screen is open. */
  watchLan(): () => void {
    return discovery.watch((_runtimes, _denied, hosts) => this.setDiscovered(hosts));
  }

  private async options(): Promise<RemoteHostOptions> {
    this.key ??= loadDeviceKey(remoteDeviceKeyStore);
    const deviceKey = await this.key.catch(error => {
      this.key = undefined;
      throw error;
    });
    return {
      deviceKey, deviceName: deviceName(), bonjour: id => this.bonjour.get(id) ?? [],
      onRecord: () => {
        this.changed();
        void this.persist();
      },
    };
  }

  private watch(host: RemoteHost) {
    host.subscribe(() => this.changed());
    return host;
  }

  private replace(hosts: RemoteHost[]) {
    this.hosts = hosts;
    this.changed();
  }

  private changed() {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }

  private persist() {
    return native.storageSet(SESSION_SCOPE, HOSTS_KEY, this.hosts.map(host => host.record)).catch(() => undefined);
  }
}

export const remoteHosts = new RemoteHosts();
