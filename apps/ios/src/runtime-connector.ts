import { AUTO_RECONNECT_SETTING, KEEP_ALIVE_SETTING, RuntimeStatusStore, clientStatus, keepAliveMs, type RuntimeSettingsAccess } from "@oxbit/feature-runtime";
import type { DiscoveredRuntime, RuntimeConnector, RuntimeTarget, SshHostSummary } from "@oxbit/workbench";
import { SESSION_SCOPE, discovery, native, ssh, type RecentWorkspace } from "@oxbit/host-ios";
import type { OpenRequest, OpenWorkspace } from "./workspaces.js";
import { COMPUTER_PREFIX, computerTarget, readPairingLink, remoteHosts } from "./remote-hosts.js";
import type { Offer } from "@oxbit/sdk/tunnel";

const SETTINGS_KEY = "runtime-settings";
const runtimeSettings = [KEEP_ALIVE_SETTING, AUTO_RECONNECT_SETTING];

/** What the app shell does for the connector; set once the shell mounts. */
export interface IosRuntimeHost {
  /** Resolves to an error message when the workspace did not open. */
  open(request: OpenRequest): Promise<string | undefined>;
  close(): Promise<void>;
  forget(id: string): Promise<void>;
  startSsh(hostId: string, path: string): void;
  manageSsh(): void;
  /** Shows a paired computer's projects and folders. */
  showRemote(hostId: string): void;
  /** Asks before pairing with the computer in a pairing link. */
  confirmPairing(offer: Offer): void;
  forgetRemote(hostId: string): Promise<void>;
}

function targetOf(recent: RecentWorkspace): RuntimeTarget {
  if (recent.kind === "remote")
    return { key: recent.id, kind: "remote", name: recent.name, hostId: recent.hostId, path: recent.remotePath, detail: recent.remotePath, lastConnected: recent.lastOpened };
  return recent.kind === "sshRuntime"
    ? { key: recent.id, kind: "ssh", name: recent.name, hostId: recent.hostId, path: recent.remotePath, detail: `Oxbit runtime · ${recent.remotePath}`, lastConnected: recent.lastOpened }
    : { key: recent.id, kind: "url", name: recent.name, url: recent.url, runtimeId: recent.runtimeId, detail: recent.url, lastConnected: recent.lastOpened };
}

const savedKinds: RecentWorkspace["kind"][] = ["runtime", "sshRuntime", "remote"];

/** One per app launch; the open workspace changes as the user connects and closes runtimes. */
export class IosRuntimeConnector implements RuntimeConnector {
  readonly store = new RuntimeStatusStore();
  readonly startCommand = "oxbit --lan";
  host?: IosRuntimeHost;
  private workspace?: OpenWorkspace;
  private saved: RecentWorkspace[] = [];
  private all: RecentWorkspace[] = [];
  private mirror: Record<string, unknown> = {};
  private detach: (() => void)[] = [];
  private paired?: { version: number; targets: RuntimeTarget[] };
  status = this.store.get;
  subscribe = (listener: () => void) => {
    const offStatus = this.store.subscribe(listener);
    const offHosts = remoteHosts.subscribe(listener);
    return () => {
      offStatus();
      offHosts();
    };
  };
  /** Paired computers; the array changes only when a computer or its presence changes. */
  computers = (): RuntimeTarget[] => {
    if (this.paired?.version !== remoteHosts.version) this.paired = { version: remoteHosts.version, targets: remoteHosts.list().map(computerTarget) };
    return this.paired.targets;
  };

  /** The start screen has no kernel, so runtime settings are mirrored to app storage. */
  async loadSettings() {
    this.mirror = await native.storageGet<Record<string, unknown>>(SESSION_SCOPE, SETTINGS_KEY).catch(() => null) ?? {};
  }
  readonly settings: RuntimeSettingsAccess = {
    get: <T>(id: string) => (this.workspace ? this.workspace.session.kernel.configuration.get<T>(id) : this.mirror[id] as T | undefined),
    set: (id, value) => {
      this.remember(id, value);
      if (this.workspace) return this.workspace.session.kernel.configuration.set(id, value as never);
    },
  };
  private remember(id: string, value: unknown) {
    if (this.mirror[id] === value) return;
    this.mirror = { ...this.mirror, [id]: value };
    void native.storageSet(SESSION_SCOPE, SETTINGS_KEY, this.mirror).catch(() => {});
  }
  keepAlive() { return keepAliveMs(this.settings.get(KEEP_ALIVE_SETTING)); }
  autoReconnect() { return this.settings.get(AUTO_RECONNECT_SETTING) !== false; }

  setRecents(recents: RecentWorkspace[]) {
    this.all = recents;
    this.saved = recents.filter(item => savedKinds.includes(item.kind));
  }

  attach(workspace?: OpenWorkspace) {
    for (const off of this.detach) off();
    this.detach = [];
    this.workspace = workspace;
    const runtime = workspace?.session.runtime;
    if (!workspace) return this.store.replace({ state: "disconnected", error: this.store.get().error });
    const configuration = workspace.session.kernel.configuration;
    for (const id of runtimeSettings)
      if (id in this.mirror && configuration.get(id) !== this.mirror[id]) void configuration.set(id, this.mirror[id] as never);
    const follow = () => {
      for (const id of runtimeSettings) this.remember(id, configuration.get(id));
      if (runtime) runtime.autoReconnect = this.autoReconnect();
    };
    follow();
    this.detach.push(configuration.subscribe(follow));
    if (!runtime) return this.store.replace({ state: "disconnected", error: this.store.get().error });
    const { kind, hostId, name, remotePath } = workspace.recent;
    const remote = kind === "sshRuntime" || kind === "remote";
    const sync = () => this.store.replace({
      state: runtime.connected ? "connected" : this.store.get().state === "failed" ? "failed" : "reconnecting",
      ...clientStatus(runtime, kind === "remote" ? "remote" : remote ? "ssh" : "url", name), targetKey: workspace.recent.id,
      ...(remote ? { host: (hostId && remoteHosts.get(hostId)?.record.name) ?? name.split(":")[0], port: undefined, workspace: remotePath } : {}),
    });
    sync();
    this.detach.push(
      runtime.subscribe("connection.change", ({ state }) => state === "disconnected" ? this.store.set({ state: "disconnected" }) : sync()),
      runtime.subscribe("workspace.trust", ({ trusted }) => this.store.set({ trusted: trusted === true })),
    );
  }

  /** The open workspace's runtime; an SFTP folder starts one on its host at that folder. */
  quickTarget(): RuntimeTarget | undefined {
    const current = this.workspace?.recent;
    if (current && savedKinds.includes(current.kind)) return targetOf(current);
    if (current?.kind === "ssh" && current.hostId && current.remotePath) {
      const { hostId, remotePath } = current;
      const saved = this.saved.find(item => item.kind === "sshRuntime" && item.hostId === hostId && item.remotePath === remotePath);
      return saved ? targetOf(saved)
        : { key: `ssh:${hostId}:${remotePath}`, kind: "ssh", name: current.name, hostId, path: remotePath, detail: `Oxbit runtime · ${remotePath}` };
    }
    return this.saved[0] && targetOf(this.saved[0]);
  }
  async recents() { return this.saved.map(targetOf); }
  async forget(target: RuntimeTarget) {
    if (target.key.startsWith(COMPUTER_PREFIX) && target.hostId) await this.host?.forgetRemote(target.hostId);
    else await this.host?.forget(target.key);
  }

  private async open(request: OpenRequest, label: string) {
    if (!this.host) throw new Error("Oxbit is still starting.");
    this.store.replace({ ...this.store.get(), state: "connecting", progress: `Connecting to ${label}…`, error: undefined });
    const error = await this.host.open(request);
    if (error) {
      this.store.fail(error);
      throw new Error(error);
    }
  }
  async connect(target: RuntimeTarget) {
    if (target.kind === "remote") {
      if (!target.hostId) throw new Error("This computer is no longer paired. Run oxbit remote pair on your computer for a new link.");
      if (!target.path) return this.host?.showRemote(target.hostId);
      if (target.key === this.workspace?.recent.id) return this.restart();
      return this.open({ kind: "remote", hostId: target.hostId, path: target.path }, target.name);
    }
    if (target.kind === "ssh") {
      if (this.workspace?.remote && target.key === this.workspace.recent.id) return this.restart();
      if (target.hostId) this.host?.startSsh(target.hostId, target.path ?? "~");
      return;
    }
    if (!target.url) throw new Error("This runtime has no address. Pair it again.");
    await this.open({ kind: "runtime", url: target.url, runtimeId: target.runtimeId }, target.name);
  }
  pair(url: string, code: string) {
    return this.open({ kind: "runtime", url, code }, url);
  }
  async pairLink(link: string) {
    const offer = await readPairingLink(link);
    if (!this.host) throw new Error("Oxbit is still starting.");
    this.host.confirmPairing(offer);
  }
  async disconnect() {
    if (this.workspace?.session.runtime) await this.host?.close();
  }
  async restart() {
    const workspace = this.workspace;
    const runtime = workspace?.session.runtime;
    if (workspace?.recent.kind === "remote") return this.restartRemote(workspace);
    if (!workspace?.remote) {
      runtime?.reconnect();
      return;
    }
    this.store.set({ state: "connecting", progress: "Reconnecting over SSH…", error: undefined });
    try {
      await ssh.runtimeResume(workspace.remote.id);
    } catch (error) {
      this.store.fail(error);
      throw error;
    }
    await runtime?.reconnect().catch(() => {});
    if (this.workspace === workspace) this.store.set({ state: runtime?.connected ? "connected" : "reconnecting", progress: undefined });
  }
  /** Reconnects the computer's tunnel, then the runtime over it. */
  private async restartRemote(workspace: OpenWorkspace) {
    const runtime = workspace.session.runtime;
    const host = workspace.recent.hostId ? remoteHosts.get(workspace.recent.hostId) : undefined;
    this.store.set({ state: "connecting", progress: `Reconnecting to ${host?.record.name ?? workspace.recent.name}…`, error: undefined });
    try {
      if (!host) throw new Error("This computer is no longer paired. Run oxbit remote pair on your computer for a new link.");
      await host.reconnect();
      if (runtime && !runtime.connected) await runtime.reconnect();
    } catch (error) {
      if (this.workspace === workspace) this.store.fail(error);
      throw error;
    }
    if (this.workspace === workspace) this.store.set({ state: runtime?.connected ? "connected" : "reconnecting", progress: undefined });
  }
  async trust(trusted: boolean) {
    const session = this.workspace?.session;
    if (!session?.runtime) return;
    await session.runtime.trust(trusted);
    this.store.set({ trusted: !!session.runtime.session?.trusted });
    session.kernel.context.set("trusted", !!session.runtime.session?.trusted);
    session.workbench.touch();
  }
  discover(listener: (runtimes: DiscoveredRuntime[], localNetworkDenied?: boolean) => void) {
    return discovery.watch((runtimes, localNetworkDenied, hosts) => {
      remoteHosts.setDiscovered(hosts ?? []);
      listener(runtimes.map(runtime => ({ ...runtime, paired: this.saved.some(recent => recent.runtimeId === runtime.runtimeId) })), localNetworkDenied);
    });
  }
  async sshHosts(): Promise<SshHostSummary[]> {
    const hosts = await ssh.hosts();
    return hosts.map(host => ({
      id: host.id, label: host.label, detail: `${host.username}@${host.hostname}${host.port === 22 ? "" : ":" + host.port}`,
      lastPath: this.lastFolder(host.id),
    }));
  }
  /** The open workspace's folder on this host, else the most recent one. */
  lastFolder(hostId: string) {
    const current = this.workspace?.recent;
    if (current?.hostId === hostId && current.remotePath) return current.remotePath;
    return this.all.find(recent => recent.hostId === hostId && recent.remotePath)?.remotePath;
  }
  async startSsh(hostId: string, path: string) { this.host?.startSsh(hostId, path); }
  manageSsh() { this.host?.manageSsh(); }
}

export const runtimeConnector = new IosRuntimeConnector();
