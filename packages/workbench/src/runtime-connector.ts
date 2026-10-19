/** The remote access device client, for apps that reach host-runtime only through this package. */
export { RemoteError, RemoteHost, loadDeviceKey, readPairingLink, remoteRuntimeUrl } from "@oxbit/host-runtime";
export type { DeviceKeyStore, HostInfo, HostListing, HostProject, PairedHost, RemoteHostOptions, RemoteHostState, RemoteHostStatus } from "@oxbit/host-runtime";

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
  kind?: "local" | "url" | "ssh" | "remote";
  /** Host name reported by the runtime, the SSH host label, or the paired computer's name. */
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
  kind: "local" | "url" | "ssh" | "remote";
  name: string;
  runtimeId?: string;
  url?: string;
  /** The SSH host id, or the paired computer's host id. */
  hostId?: string;
  /** A folder on the server or paired computer; a paired computer without one opens its host screen. */
  path?: string;
  detail?: string;
  lastConnected?: number;
  /** A paired computer's presence; undefined while it is unknown. */
  online?: boolean;
  /** Epoch milliseconds a paired computer was last reachable. */
  lastSeen?: number;
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

/** A device paired with this computer's remote access host. Times are epoch milliseconds. */
export interface RemoteAccessDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
}

/** `oxbit remote status --json`. */
export interface RemoteAccessStatus {
  /** The login item is installed. */
  enabled: boolean;
  running: boolean;
  /** Null until the host has keys. */
  hostId: string | null;
  name: string;
  relay: { url: string | null; connected: boolean; state?: string };
  lan: { port: number | null; addresses: string[] };
  devices: RemoteAccessDevice[];
}

/** A single-use pairing link from `oxbit remote pair --json`. */
export interface RemoteAccessOffer {
  link: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  host: { id: string; name: string };
}

export type RemoteAccessPairing = { paired: { id: string; name: string } } | { expired: true };

/** This computer's remote access host, driven through `oxbit remote`. */
export interface RemoteAccess {
  status(): Promise<RemoteAccessStatus>;
  /** Starts the host now and at login. */
  enable(): Promise<void>;
  /** Stops the host and removes the login item; keys and devices stay. */
  disable(): Promise<void>;
  revoke(deviceId: string): Promise<void>;
  /** Calls `onOffer` with the link, then settles when a device pairs or the link expires; `signal` stops waiting. */
  pair(onOffer: (offer: RemoteAccessOffer) => void, signal?: AbortSignal): Promise<RemoteAccessPairing>;
}

/** Optional members are capabilities; the Runtime page hides controls a host does not provide. */
export interface RuntimeConnector {
  status(): RuntimeStatus;
  subscribe(listener: () => void): () => void;
  /** The runtime this workspace already knows: an SSH host and folder, or a saved runtime. */
  quickTarget(): RuntimeTarget | undefined;
  connect(target: RuntimeTarget): Promise<void>;
  pair?(url: string, code: string): Promise<void>;
  /** Pairs with a computer from an `oxbit remote pair` link. */
  pairLink?(link: string): Promise<void>;
  /** Paired computers, kind `remote`. Returns the same array until `subscribe` listeners run. */
  computers?(): RuntimeTarget[];
  recents(): Promise<RuntimeTarget[]>;
  forget?(target: RuntimeTarget): Promise<void>;
  disconnect?(): Promise<void>;
  restart?(): Promise<void>;
  trust?(trusted: boolean): Promise<void>;
  /** `localNetworkDenied` reports that the OS blocks local network browsing for the app. */
  discover?(listener: (runtimes: DiscoveredRuntime[], localNetworkDenied?: boolean) => void): () => void;
  sshHosts?(): Promise<SshHostSummary[]>;
  startSsh?(hostId: string, path: string): Promise<void>;
  manageSsh?(): void;
  /** Lets devices on other networks reach this computer. */
  remoteAccess?: RemoteAccess;
  /** Shell command shown with the pairing form. */
  startCommand?: string;
}
