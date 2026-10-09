import { RUNTIME_OUTPUT_SEPARATOR, splitRuntimeError } from "@oxbit/protocol";
import { RuntimeStatusStore, clientStatus } from "@oxbit/feature-runtime";
import type { RuntimeConnector, RuntimeTarget, SshHostSummary } from "@oxbit/workbench";
import type { Session } from "@oxbit/app-workbench";

export interface DesktopRuntimeHost {
  restart(): Promise<void>;
  recent(): string[];
  open(path: string): Promise<unknown>;
  /** Opens `ssh://<authority><path>` as a project; authority is `[user@]host[:port]`. */
  startSsh?(authority: string, path: string): Promise<void>;
  manageSsh?(): void;
}

const remoteParts = (uri: string) => {
  const match = /^ssh:\/\/([^/]+)(\/.*)?$/.exec(uri);
  if (!match) return undefined;
  const path = decodeURIComponent(match[2] ?? "/").replace(/^\/~(?=\/|$)/, "~");
  return { authority: match[1], path };
};

/** Follows one desktop project's runtime across restarts; each new session attaches to it. */
export class DesktopRuntimeConnector implements RuntimeConnector {
  readonly store = new RuntimeStatusStore();
  private session?: Session;
  private detach: (() => void)[] = [];
  constructor(private readonly project: () => { key: string; path: string; name: string }, private readonly host: DesktopRuntimeHost) {}
  status = this.store.get;
  subscribe = this.store.subscribe;
  private get remote() { return remoteParts(this.project().path); }
  private get key() { return "project:" + this.project().key; }

  attach(session: Session) {
    for (const off of this.detach) off();
    this.session = session;
    const runtime = session.runtime;
    if (!runtime) return;
    const remote = this.remote;
    const sync = () => {
      const state = runtime.connected ? "connected" : this.store.get().state === "failed" ? "failed" : "reconnecting";
      const status = clientStatus(runtime, remote ? "ssh" : "local");
      this.store.replace({
        ...status, state, targetKey: this.key, error: state === "connected" ? undefined : this.store.get().error,
        ...(remote ? { name: remote.authority, host: remote.authority, port: undefined, workspace: remote.path } : {}),
      });
    };
    sync();
    this.detach = [
      runtime.subscribe("connection.change", sync),
      runtime.subscribe("workspace.trust", ({ trusted }) => this.store.set({ trusted: trusted === true })),
    ];
  }
  /** Records a runtime that stopped or could not start, keeping its stderr tail as detail. */
  failed(message: string, detail?: string) {
    const split = splitRuntimeError(detail ? message + RUNTIME_OUTPUT_SEPARATOR + detail : message);
    this.store.replace({ ...this.store.get(), state: "failed", progress: undefined, error: { ...split, at: Date.now() } });
  }

  quickTarget(): RuntimeTarget {
    const project = this.project();
    const remote = this.remote;
    return { key: this.key, kind: remote ? "ssh" : "local", name: remote?.authority ?? project.name, path: project.path };
  }
  async connect(target: RuntimeTarget) {
    if (target.key === this.key) return this.restart();
    if (target.path) await this.host.open(target.path);
  }
  async recents() {
    return this.host.recent().flatMap((uri): RuntimeTarget[] => {
      const parts = remoteParts(uri);
      return parts ? [{ key: "ssh:" + uri, kind: "ssh", name: parts.authority, path: uri, detail: parts.path, hostId: parts.authority }] : [];
    });
  }
  async restart() {
    this.store.set({ state: "connecting", progress: this.remote ? "Reconnecting over SSH…" : "Restarting the runtime…", error: undefined });
    await this.host.restart();
  }
  async trust(trusted: boolean) {
    const session = this.session;
    if (!session?.runtime) return;
    await session.runtime.trust(trusted);
    this.store.set({ trusted: !!session.runtime.session?.trusted });
    session.kernel.context.set("trusted", !!session.runtime.session?.trusted);
    session.workbench.touch();
  }
  sshHosts = async (): Promise<SshHostSummary[]> => {
    const hosts = new Map<string, SshHostSummary>();
    for (const target of await this.recents())
      if (!hosts.has(target.hostId!)) hosts.set(target.hostId!, { id: target.hostId!, label: target.name, detail: target.detail ?? "", lastPath: target.detail });
    return [...hosts.values()];
  };
  get startSsh() {
    const start = this.host.startSsh;
    return start && ((authority: string, path: string) => start(authority, path));
  }
  get manageSsh() {
    return this.host.manageSsh;
  }
}
