/** Kernel service id; each app registers one connector per workbench session. */
export const RUNTIME_CONNECTOR_SERVICE = "runtimeConnector";

export type RuntimeConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected" | "failed";

export interface RuntimeProblem {
  message: string;
  /** Runtime stderr tail, remote output, or the underlying error text. */
  detail?: string;
  at: number;
}

export interface RuntimeStatus {
  state: RuntimeConnectionState;
  kind?: "local" | "url" | "ssh";
  /** Host name reported by the runtime, or the SSH host label. */
  name?: string;
  url?: string;
  host?: string;
  port?: number;
  version?: string;
  /** Epoch milliseconds when the runtime started listening. */
  startedAt?: number;
  runtimeId?: string;
  /** Key of the saved RuntimeTarget this connection came from. */
  targetKey?: string;
  workspace?: string;
  trusted?: boolean;
  owner?: boolean;
  progress?: string;
  error?: RuntimeProblem;
}

/** A runtime this device knows how to reach again. */
export interface RuntimeTarget {
  key: string;
  kind: "url" | "ssh";
  name: string;
  runtimeId?: string;
  url?: string;
  hostId?: string;
  path?: string;
  detail?: string;
  lastConnected?: number;
}

export interface DiscoveredRuntime {
  runtimeId: string;
  name: string;
  version?: string;
  host: string;
  port: number;
  url: string;
  /** A credential for this runtime id is saved, so connecting needs no code. */
  paired: boolean;
}

export interface SshHostSummary {
  id: string;
  label: string;
  detail: string;
  lastPath?: string;
}

/** Optional members are capabilities; the Runtime page hides controls a host does not provide. */
export interface RuntimeConnector {
  status(): RuntimeStatus;
  subscribe(listener: () => void): () => void;
  /** The runtime this workspace already knows: an SSH host and folder, or a saved runtime. */
  quickTarget(): RuntimeTarget | undefined;
  connect(target: RuntimeTarget): Promise<void>;
  pair(url: string, code: string): Promise<void>;
  recents(): Promise<RuntimeTarget[]>;
  forget?(target: RuntimeTarget): Promise<void>;
  disconnect?(): Promise<void>;
  restart?(): Promise<void>;
  trust?(trusted: boolean): Promise<void>;
  discover?(listener: (runtimes: DiscoveredRuntime[]) => void): () => void;
  sshHosts?(): Promise<SshHostSummary[]>;
  startSsh?(hostId: string, path: string): Promise<void>;
  manageSsh?(): void;
  /** Shell command shown with the pairing form. */
  startCommand?: string;
}
