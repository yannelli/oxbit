import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RELAY, hostIdFromKey } from "@oxbit/sdk/tunnel";
import {
  ensureState,
  fileLogger,
  loadConfig,
  loadOrCreateHost,
  matchDevice,
  readDevices,
  remotePaths,
  resetHost,
  writeDevices,
  type Device,
} from "../src/remote/state.js";
import { OfferBook } from "../src/remote/offers.js";
import { reconnectDelay } from "../src/remote/relay.js";
import { REMOTE_SERVICE_TYPE } from "../src/remote/lan.js";
import { records, serviceName, TYPE } from "../src/mdns-wire.js";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
});
async function temp() {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxr-state-"));
  directories.push(directory);
  return directory;
}
const mode = async (file: string) => (await fs.stat(file)).mode & 0o777;

describe("remote state", () => {
  it("defaults to ~/.oxbit/remote and honors OXBIT_REMOTE_DIR", () => {
    expect(remotePaths({}, "/home/me").dir).toBe("/home/me/.oxbit/remote");
    const paths = remotePaths({ OXBIT_REMOTE_DIR: "/tmp/r" }, "/home/me");
    expect(paths).toMatchObject({ dir: "/tmp/r", host: "/tmp/r/host.json", devices: "/tmp/r/devices.json", config: "/tmp/r/remote.json", log: "/tmp/r/remote.log" });
  });

  it("creates a 0700 directory with 0600 files and keeps the keys on repeat", async () => {
    const paths = remotePaths({ OXBIT_REMOTE_DIR: path.join(await temp(), "remote") });
    const first = await ensureState(paths, {});
    expect(await mode(paths.dir)).toBe(0o700);
    for (const file of [paths.host, paths.devices, paths.config, paths.log]) expect(await mode(file)).toBe(0o600);
    expect(first.config).toEqual({ relay: DEFAULT_RELAY, lanPort: 0 });
    expect(first.identity.id).toBe(await hostIdFromKey(first.identity.admission.publicKey));
    const stored = JSON.parse(await fs.readFile(paths.host, "utf8"));
    expect(stored).toMatchObject({ version: 1, id: first.identity.id, ed25519: { publicKey: expect.any(String), privateKey: expect.any(String) } });
    const again = await ensureState(paths, {});
    expect(again.identity.id).toBe(first.identity.id);
    expect(await fs.readdir(paths.dir)).toEqual(expect.not.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  });

  it("creates the keys once when two starts race", async () => {
    const paths = remotePaths({ OXBIT_REMOTE_DIR: await temp() });
    const [a, b, c] = await Promise.all([loadOrCreateHost(paths), loadOrCreateHost(paths), loadOrCreateHost(paths)]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
  });

  it("rejects a host file whose id does not match its key", async () => {
    const paths = remotePaths({ OXBIT_REMOTE_DIR: await temp() });
    await loadOrCreateHost(paths);
    const stored = JSON.parse(await fs.readFile(paths.host, "utf8"));
    await fs.writeFile(paths.host, JSON.stringify({ ...stored, id: "A".repeat(22) }));
    await expect(loadOrCreateHost(paths)).rejects.toThrow("does not match");
  });

  it("lets OXBIT_RELAY replace the relay without rewriting remote.json", async () => {
    const paths = remotePaths({ OXBIT_REMOTE_DIR: await temp() });
    await ensureState(paths, {});
    expect(await loadConfig(paths, { OXBIT_RELAY: "ws://127.0.0.1:9/" })).toEqual({ relay: "ws://127.0.0.1:9", lanPort: 0 });
    expect(JSON.parse(await fs.readFile(paths.config, "utf8")).relay).toBe(DEFAULT_RELAY);
    await expect(loadConfig(paths, { OXBIT_RELAY: "https://relay.example" })).rejects.toThrow("ws:// or wss://");
    await fs.writeFile(paths.config, JSON.stringify({ relay: DEFAULT_RELAY, lanPort: 70000 }));
    await expect(loadConfig(paths, {})).rejects.toThrow("lanPort");
  });

  it("resets to new keys and no devices", async () => {
    const paths = remotePaths({ OXBIT_REMOTE_DIR: await temp() });
    const { identity } = await ensureState(paths, {});
    await writeDevices(paths, [{ id: "abc", name: "iPhone", pairedAt: 1, lastSeen: 2 }]);
    const fresh = await resetHost(paths);
    expect(fresh.id).not.toBe(identity.id);
    expect(await readDevices(paths)).toEqual([]);
    expect((await loadOrCreateHost(paths)).id).toBe(fresh.id);
  });

  it("logs to remote.log with owner-only access", async () => {
    const paths = remotePaths({ OXBIT_REMOTE_DIR: await temp() });
    fileLogger(paths.log, false)("hello");
    expect(await fs.readFile(paths.log, "utf8")).toMatch(/^\d{4}-\d\d-\d\dT.* hello\n$/);
    expect(await mode(paths.log)).toBe(0o600);
  });
});

describe("device matching", () => {
  const devices: Device[] = [
    { id: "AbCdEfGh1234", name: "iPhone", pairedAt: 0, lastSeen: 0 },
    { id: "AbCdXyZ98765", name: "iPad", pairedAt: 0, lastSeen: 0 },
  ];
  it("matches a name, an exact id, or a unique id prefix", () => {
    expect(matchDevice(devices, "ipad")).toEqual({ device: devices[1] });
    expect(matchDevice(devices, "AbCdEfGh1234")).toEqual({ device: devices[0] });
    expect(matchDevice(devices, "AbCdE")).toEqual({ device: devices[0] });
    expect(matchDevice(devices, "AbCd")).toEqual({ error: expect.stringContaining("matches 2 devices") });
    expect(matchDevice(devices, "Ab")).toEqual({ error: expect.stringContaining("No paired device") });
  });
});

describe("offers and reconnect delay", () => {
  it("claims an offer once, releases it after a failed handshake, and reports the outcome", async () => {
    const book = new OfferBook(60_000);
    const offer = { v: 1 as const, h: "h", e: "e", x: "x", o: "offer", k: "A".repeat(43), r: DEFAULT_RELAY, n: "Mac" };
    book.add(offer);
    expect(book.claim("offer")).toHaveLength(32);
    expect(book.claim("offer")).toBeUndefined();
    book.release("offer");
    expect(book.claim("offer")).toBeDefined();
    const waiting = book.wait("offer");
    book.complete("offer", { id: "d", name: "iPhone" });
    expect(await waiting).toEqual({ paired: { id: "d", name: "iPhone" } });
    expect(await book.wait("offer")).toEqual({ paired: { id: "d", name: "iPhone" } });
    expect(book.claim("offer")).toBeUndefined();
    expect(await book.wait("missing")).toEqual({ expired: true });
  });

  it("expires an unused offer after its TTL", async () => {
    const book = new OfferBook(30);
    book.add({ v: 1, h: "h", e: "e", x: "x", o: "soon", k: "A".repeat(43), r: DEFAULT_RELAY, n: "Mac" });
    expect(await book.wait("soon")).toEqual({ expired: true });
    expect(book.claim("soon")).toBeUndefined();
  });

  it("caps exponential backoff and keeps jitter in the upper half", () => {
    expect(reconnectDelay(0, 1000, 60_000, () => 0)).toBe(500);
    expect(reconnectDelay(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(reconnectDelay(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(reconnectDelay(20, 1000, 60_000, () => 0)).toBe(30_000);
    expect(reconnectDelay(20, 1000, 60_000, () => 1)).toBe(60_000);
  });
});

describe("remote Bonjour records", () => {
  it("advertises _oxbit-remote._tcp with id, name, version and port, and keeps _oxbit._tcp as the default", () => {
    const ad = { id: "HostIdHostIdHostIdHost", name: "Studio", version: "1.2.3", port: 4567, v4: ["10.0.0.2"], v6: [] };
    expect(serviceName()).toEqual(["_oxbit", "_tcp", "local"]);
    const remote = records({ ...ad, service: REMOTE_SERVICE_TYPE });
    expect(remote.find((record) => record.type === TYPE.PTR)!.name).toEqual(["_oxbit-remote", "_tcp", "local"]);
    expect(remote.find((record) => record.type === TYPE.TXT)!.strings).toEqual(["id=HostIdHostIdHostIdHost", "name=Studio", "version=1.2.3", "port=4567"]);
    expect(records(ad).find((record) => record.type === TYPE.PTR)!.name).toEqual(["_oxbit", "_tcp", "local"]);
  });
});
