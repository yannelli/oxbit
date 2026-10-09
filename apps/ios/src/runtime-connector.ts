import { AUTO_RECONNECT_SETTING, KEEP_ALIVE_SETTING, RuntimeStatusStore, clientStatus, keepAliveMs, type RuntimeSettingsAccess } from "@oxbit/feature-runtime";
import type { DiscoveredRuntime, RuntimeConnector, RuntimeTarget, SshHostSummary } from "@oxbit/workbench";
import { SESSION_SCOPE, discovery, native, ssh, type RecentWorkspace } from "@oxbit/host-ios";
import type { OpenRequest, OpenWorkspace } from "./workspaces.js";

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
}

function targetOf(recent: RecentWorkspace): RuntimeTarget {
  return recent.kind === "sshRuntime"
    ? { key: recent.id, kind: "ssh", name: recent.name, hostId: recent.hostId, path: recent.remotePath, detail: `Oxbit runtime · ${recent.remotePath}`, lastConnected: recent.lastOpened }
    : { key: recent.id, kind: "url", name: recent.name, url: recent.url, runtimeId: recent.runtimeId, detail: recent.url, lastConnected: recent.lastOpened };
}

/** One per app launch; the open workspace changes as the user connects and closes runtimes. */
export class IosRuntimeConnector implements RuntimeConnector {
  readonly store = new RuntimeStatusStore();
  readonly startCommand = "oxbit --lan";
  host?: IosRuntimeHost;
  private workspace?: OpenWorkspace;
  private saved: RecentWorkspace[] = [];
  private mirror: Record<string, unknown> = {};
  private detach: (() => void)[] = [];
  status = this.store.get;
  subscribe = this.store.subscribe;

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

  setRecents(recents: RecentWorkspace[]) { this.saved = recents.filter(item => item.kind === "runtime" || item.kind === "sshRuntime"); }

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
    const remote = workspace.recent.kind === "sshRuntime";
    const sync = () => this.store.replace({
      state: runtime.connected ? "connected" : this.store.get().state === "failed" ? "failed" : "reconnecting",
      ...clientStatus(runtime, remote ? "ssh" : "url", workspace.recent.name), targetKey: workspace.recent.id,
      ...(remote ? { host: workspace.recent.name.split(":")[0], port: undefined, workspace: workspace.recent.remotePath } : {}),
    });
    sync();
    this.detach.push(
      runtime.subscribe("connection.change", ({ state }) => state === "disconnected" ? this.store.set({ state: "disconnected" }) : sync()),
      runtime.subscribe("workspace.trust", ({ trusted }) => this.store.set({ trusted: trusted === true })),
    );
  }

  quickTarget(): RuntimeTarget | undefined {
    const current = this.workspace?.recent;
    if (current && (current.kind === "runtime" || current.kind === "sshRuntime")) return targetOf(current);
    return this.saved[0] && targetOf(this.saved[0]);
  }
  async recents() { return this.saved.map(targetOf); }
  async forget(target: RuntimeTarget) { await this.host?.forget(target.key); }

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
    if (target.kind === "ssh") {
      if (target.hostId) this.host?.startSsh(target.hostId, target.path ?? "~");
      return;
    }
    if (!target.url) throw new Error("This runtime has no address. Pair it again.");
    await this.open({ kind: "runtime", url: target.url, runtimeId: target.runtimeId }, target.name);
  }
  pair(url: string, code: string) {
    return this.open({ kind: "runtime", url, code }, url);
  }
  async disconnect() {
    if (this.workspace?.session.runtime) await this.host?.close();
  }
  async restart() {
    const workspace = this.workspace;
    if (workspace?.remote) await ssh.runtimeResume(workspace.remote.id);
    else workspace?.session.runtime?.reconnect();
  }
  async trust(trusted: boolean) {
    const session = this.workspace?.session;
    if (!session?.runtime) return;
    await session.runtime.trust(trusted);
    this.store.set({ trusted: !!session.runtime.session?.trusted });
    session.kernel.context.set("trusted", !!session.runtime.session?.trusted);
    session.workbench.touch();
  }
  discover(listener: (runtimes: DiscoveredRuntime[]) => void) {
    return discovery.watch(runtimes => listener(runtimes.map(runtime => ({
      ...runtime, paired: this.saved.some(recent => recent.runtimeId === runtime.runtimeId),
    }))));
  }
  async sshHosts(): Promise<SshHostSummary[]> {
    const hosts = await ssh.hosts();
    return hosts.map(host => ({
      id: host.id, label: host.label, detail: `${host.username}@${host.hostname}${host.port === 22 ? "" : ":" + host.port}`,
      lastPath: this.saved.find(recent => recent.hostId === host.id)?.remotePath,
    }));
  }
  async startSsh(hostId: string, path: string) { this.host?.startSsh(hostId, path); }
  manageSsh() { this.host?.manageSsh(); }
}

export const runtimeConnector = new IosRuntimeConnector();
