import * as fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_RELAY,
  exportKeyPair,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  hostIdFromKey,
  importKeyPair,
  type KeyPair,
  type StoredKeyPair,
} from "@oxbit/sdk/tunnel";
import { setting } from "../branding.js";
import type { Environment } from "../daemon.js";

export interface RemotePaths {
  dir: string;
  host: string;
  devices: string;
  config: string;
  projects: string;
  log: string;
  socket: string;
}
export interface HostIdentity {
  id: string;
  admission: KeyPair;
  static: KeyPair;
}
interface HostFile {
  version: 1;
  id: string;
  ed25519: StoredKeyPair;
  x25519: StoredKeyPair;
  createdAt: number;
}
export interface RemoteConfig {
  relay: string;
  /** 0 picks a free port at each start. */
  lanPort: number;
}
/** Times are epoch milliseconds. */
export interface Device {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
}
export interface ProjectRecord {
  path: string;
  lastOpened: number;
}
export type Logger = (line: string) => void;

export class StateError extends Error {
  readonly code = "STATE";
}

export function remotePaths(env: Environment = process.env, home = os.homedir()): RemotePaths {
  const dir = path.resolve(setting("REMOTE_DIR", env) ?? path.join(home, ".oxbit", "remote"));
  const file = (name: string) => path.join(dir, name);
  return {
    dir,
    host: file("host.json"),
    devices: file("devices.json"),
    config: file("remote.json"),
    projects: file("projects.json"),
    log: file("remote.log"),
    socket: file("ctl.sock"),
  };
}

const tempName = (file: string) => `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

async function writeTemp(file: string, value: unknown) {
  const temp = tempName(file);
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  return temp;
}

export async function writeJsonAtomic(file: string, value: unknown) {
  const temp = await writeTemp(file, value);
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** Writes `value` only when `file` does not exist yet; returns false when another writer won. */
async function createJsonOnce(file: string, value: unknown) {
  const temp = await writeTemp(file, value);
  try {
    await fs.link(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new StateError(`${file} is not valid JSON`);
  }
}

async function newHostFile(): Promise<HostFile> {
  const admission = await generateEd25519KeyPair();
  const staticKey = await generateX25519KeyPair();
  return {
    version: 1,
    id: await hostIdFromKey(admission.publicKey),
    ed25519: await exportKeyPair(admission),
    x25519: await exportKeyPair(staticKey),
    createdAt: Date.now(),
  };
}

async function importHost(file: HostFile | undefined, where: string): Promise<HostIdentity> {
  if (file?.version !== 1 || !file.ed25519 || !file.x25519) throw new StateError(`${where} is not an Oxbit host key file`);
  const admission = await importKeyPair("Ed25519", file.ed25519);
  const id = await hostIdFromKey(admission.publicKey);
  if (id !== file.id) throw new StateError(`${where} host id does not match its Ed25519 key`);
  return { id, admission, static: await importKeyPair("X25519", file.x25519) };
}

export async function ensureRemoteDir(paths: RemotePaths) {
  await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.dir, 0o700);
}

/** Loads `host.json`, creating the keys on first use. */
export async function loadOrCreateHost(paths: RemotePaths): Promise<HostIdentity> {
  const existing = await readJson<HostFile>(paths.host);
  if (existing) return importHost(existing, paths.host);
  await createJsonOnce(paths.host, await newHostFile());
  return importHost(await readJson<HostFile>(paths.host), paths.host);
}

export async function readHostId(paths: RemotePaths) {
  const file = await readJson<HostFile>(paths.host).catch(() => undefined);
  return typeof file?.id === "string" ? file.id : undefined;
}

/** New keys and an empty device list. */
export async function resetHost(paths: RemotePaths): Promise<HostIdentity> {
  await ensureRemoteDir(paths);
  const file = await newHostFile();
  await writeJsonAtomic(paths.host, file);
  await writeJsonAtomic(paths.devices, []);
  return importHost(file, paths.host);
}

function relayUrl(value: string) {
  try {
    if (["ws:", "wss:"].includes(new URL(value).protocol)) return value.replace(/\/+$/, "");
  } catch {
    /* reported below */
  }
  throw new StateError(`Relay must be a ws:// or wss:// URL, received "${value}"`);
}

/** `remote.json`, created with defaults once unless `create` is false; `OXBIT_RELAY` replaces the relay. */
export async function loadConfig(paths: RemotePaths, env: Environment = process.env, create = true): Promise<RemoteConfig> {
  let file = await readJson<Partial<RemoteConfig>>(paths.config);
  if (!file) {
    file = { relay: DEFAULT_RELAY, lanPort: 0 };
    if (create) await createJsonOnce(paths.config, file);
  }
  const lanPort = file.lanPort ?? 0;
  if (!Number.isInteger(lanPort) || lanPort < 0 || lanPort > 65535)
    throw new StateError(`${paths.config} lanPort must be a whole number between 0 and 65535`);
  const relay = setting("RELAY", env) ?? (typeof file.relay === "string" ? file.relay : DEFAULT_RELAY);
  return { relay: relayUrl(relay), lanPort };
}

const isDevice = (value: any): value is Device =>
  typeof value?.id === "string" && typeof value?.name === "string" && typeof value?.pairedAt === "number" && typeof value?.lastSeen === "number";

export async function readDevices(paths: RemotePaths): Promise<Device[]> {
  const list = await readJson<unknown[]>(paths.devices);
  return Array.isArray(list) ? list.filter(isDevice) : [];
}

export const writeDevices = (paths: RemotePaths, devices: Device[]) => writeJsonAtomic(paths.devices, devices);

export async function readProjects(paths: RemotePaths): Promise<ProjectRecord[]> {
  const list = await readJson<unknown[]>(paths.projects).catch(() => undefined);
  return Array.isArray(list)
    ? list.filter((item: any): item is ProjectRecord => typeof item?.path === "string" && typeof item?.lastOpened === "number")
    : [];
}

export const writeProjects = (paths: RemotePaths, projects: ProjectRecord[]) => writeJsonAtomic(paths.projects, projects);

/** Matches an exact id, a name ignoring case, or an id prefix of at least 4 characters. */
export function matchDevice(devices: Device[], query: string): { device: Device } | { error: string } {
  const text = query.trim();
  const byId = devices.find((device) => device.id === text);
  if (byId) return { device: byId };
  const byName = devices.filter((device) => device.name.toLowerCase() === text.toLowerCase());
  const matches = byName.length ? byName : text.length >= 4 ? devices.filter((device) => device.id.startsWith(text)) : [];
  if (matches.length === 1) return { device: matches[0]! };
  if (matches.length > 1) return { error: `"${query}" matches ${matches.length} devices; use a longer id prefix` };
  return { error: `No paired device matches "${query}"` };
}

/** Creates the directory, keys, config, device list and log; safe to repeat. */
export async function ensureState(paths: RemotePaths, env: Environment = process.env) {
  await ensureRemoteDir(paths);
  const identity = await loadOrCreateHost(paths);
  const config = await loadConfig(paths, env);
  await createJsonOnce(paths.devices, []);
  await fs.appendFile(paths.log, "", { mode: 0o600 });
  return { identity, config };
}

export function fileLogger(file: string, echo = process.stderr.isTTY === true): Logger {
  return (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      appendFileSync(file, text, { mode: 0o600 });
    } catch {
      /* logging must not stop the host */
    }
    if (echo) process.stderr.write(text);
  };
}
