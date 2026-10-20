import { exportKeyPair, generateX25519KeyPair, importKeyPair, parseOfferLink, type KeyPair, type Offer, type StoredKeyPair } from "@oxbit/sdk/tunnel";
import { remoteError, type RemotePath, type WebSocketFactory } from "./remote-dial.js";

/** A computer this device paired with. Nothing in it is secret. */
export interface PairedHost {
  id: string;
  name: string;
  /** Host X25519 static public key, base64url. */
  key: string;
  relay: string;
  /** LAN addresses from the pairing link, `host:port`. */
  lan?: string[];
  pairedAt: number;
  /** Epoch milliseconds this device last had a session with the host. */
  lastSeen?: number;
}

export interface HostInfo {
  id: string;
  name: string;
  version: string;
  platform: string;
  home: string;
}
export interface HostListing {
  path: string;
  parent?: string;
  entries: { name: string; kind: "directory" | "file" }[];
}
export interface HostProject {
  path: string;
  name: string;
  running: boolean;
  lastOpened?: number;
}
export interface HostOpened {
  stream: number;
  token: string;
  runtime: { id: string; name: string; version: string };
  workspace: { root: string; name: string };
}

export type RemoteHostState = "idle" | "connecting" | "online" | "offline" | "failed";
export interface RemoteHostStatus {
  state: RemoteHostState;
  via?: RemotePath;
  lastSeen?: number;
  /** One line for the person using the device. */
  error?: string;
}

/** Where the app keeps the device key, such as the iOS Keychain. */
export interface DeviceKeyStore {
  load(): Promise<StoredKeyPair | null | undefined>;
  save(pair: StoredKeyPair): Promise<void>;
}

export interface RemoteHostOptions {
  deviceKey: KeyPair;
  deviceName: string;
  /** Bonjour `host:port` addresses for a host id, tried before the pairing link's addresses. */
  bonjour?: (hostId: string) => string[];
  webSocket?: WebSocketFactory;
  /** Runs after the name, LAN addresses, or last-seen time change, so the app can save the record. */
  onRecord?: (host: PairedHost) => void;
  /** Interval of the `host.info` request that keeps the relay socket active and finds dead sockets; 0 turns it off. */
  heartbeatMs?: number;
  retryMs?: readonly number[];
}

/** Loads the device key, or generates and saves one on first use. */
export async function loadDeviceKey(store: DeviceKeyStore): Promise<KeyPair> {
  const stored = await store.load();
  if (stored) return importKeyPair("X25519", stored);
  const pair = await generateX25519KeyPair();
  await store.save(await exportKeyPair(pair));
  return pair;
}

/** Reads a pairing link or a bare offer; an invalid one throws the `invalid-link` error. */
export async function readPairingLink(text: string): Promise<Offer> {
  try {
    return await parseOfferLink(text);
  } catch {
    throw remoteError("invalid-link");
  }
}

/** Address of a runtime reached through a host; scopes and file system ids derive from it. */
export const remoteRuntimeUrl = (hostId: string) => `oxbit-remote://${hostId}`;
