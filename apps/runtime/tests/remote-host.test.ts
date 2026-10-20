import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFromKey,
  generateX25519KeyPair,
  parseOfferLink,
  randomBytes,
  type KeyPair,
  type Offer,
} from "@oxbit/sdk/tunnel";
import { connectDevice } from "./remote-device.js";
import { RemoteHost, type HostOptions } from "../src/remote/host.js";
import { readDevices, remotePaths } from "../src/remote/state.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await delay(10);
  }
}

async function startHost(options: Partial<HostOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxr-host-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  await fs.mkdir(path.join(home, "Projects"), { recursive: true });
  const paths = remotePaths({ OXBIT_REMOTE_DIR: path.join(directory, "remote") });
  const logs: string[] = [];
  const host = await RemoteHost.start({
    paths,
    home,
    env: {},
    name: "Studio Mac",
    launcher: { ensure: () => Promise.reject(new Error("no runtimes here")), list: async () => [] },
    log: (line) => logs.push(line),
    advertise: false,
    relay: false,
    ipc: false,
    lanHost: "127.0.0.1",
    ...options,
  });
  cleanup.push(() => host.close());
  return { host, paths, logs, home, url: `ws://127.0.0.1:${host.status().lan.port}/v1/connect` };
}

async function pairDevice(url: string, offer: Offer, name = "iPhone", deviceKey?: KeyPair) {
  const key = deviceKey ?? (await generateX25519KeyPair());
  const device = await connectDevice(url, { deviceKey: key, name, offer });
  cleanup.push(async () => device.socket.close());
  return { device, key };
}

const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: number; reason?: string }) => ({ code: error.code, reason: error.reason }));

describe("remote host over the LAN listener", () => {
  it("pairs with IKpsk2, then reconnects with IK", async () => {
    const { host, url, paths, home } = await startHost();
    const ticket = await host.createOffer();
    const offer = await parseOfferLink(ticket.link);
    expect(offer).toMatchObject({ h: host.id, n: "Studio Mac", r: "wss://relay.oxbit.dev", l: [`127.0.0.1:${host.status().lan.port}`] });
    expect(ticket.link).toMatch(/^https:\/\/oxbit\.dev\/c#o=/);
    const outcome = host.offers.wait(ticket.offer);

    const { device, key } = await pairDevice(url, offer);
    expect(device.host).toEqual({ v: 1, id: host.id, name: "Studio Mac" });
    const info = await device.control.request("host.info");
    expect(info).toEqual({ id: host.id, name: "Studio Mac", version: expect.any(String), platform: process.platform, home: await fs.realpath(home) });
    const id = deviceIdFromKey(key.publicKey);
    expect(await outcome).toEqual({ paired: { id, name: "iPhone" } });
    await until(async () => (await readDevices(paths)).some((entry) => entry.id === id));
    expect(host.status().devices).toEqual([expect.objectContaining({ id, name: "iPhone", connected: true })]);

    device.socket.close();
    await device.closed;
    await until(() => host.status().devices[0]!.connected === false);
    const firstSeen = host.status().devices[0]!.lastSeen;
    await delay(5);
    const again = await connectDevice(url, { deviceKey: key, name: "iPhone", hostKey: base64urlDecode(offer.x) });
    cleanup.push(async () => again.socket.close());
    expect(await again.control.request("host.list", { path: "~" })).toMatchObject({ entries: [{ name: "Projects", kind: "directory" }] });
    expect(host.status().devices[0]!.lastSeen).toBeGreaterThan(firstSeen);

    const reuse = await rejection(pairDevice(url, offer, "Second"));
    expect(reuse).toEqual({ code: 4403, reason: "offer-expired" });
  });

  it("refuses an unknown device", async () => {
    const { host, url, logs } = await startHost();
    const offer = await parseOfferLink((await host.createOffer()).link);
    const stranger = connectDevice(url, { deviceKey: await generateX25519KeyPair(), name: "Stranger", hostKey: base64urlDecode(offer.x) });
    expect(await rejection(stranger)).toEqual({ code: 4403, reason: "unknown-device" });
    expect(host.status().devices).toEqual([]);
    await until(() => logs.some((line) => line.includes("unknown-device")));
  });

  it("refuses an expired offer", async () => {
    const { host, url } = await startHost({ offerTtlMs: 40 });
    const ticket = await host.createOffer();
    expect(await host.offers.wait(ticket.offer)).toEqual({ expired: true });
    const late = pairDevice(url, await parseOfferLink(ticket.link));
    expect(await rejection(late)).toEqual({ code: 4403, reason: "offer-expired" });
  });

  it("registers nothing for a wrong psk and keeps the offer for the right one", async () => {
    const { host, url, paths } = await startHost();
    const offer = await parseOfferLink((await host.createOffer()).link);
    const wrong = { ...offer, k: base64urlEncode(randomBytes(32)) };
    await expect(pairDevice(url, wrong, "Mallory")).rejects.toThrow();
    await until(() => host.connections.size === 0);
    expect(host.status().devices).toEqual([]);
    expect(await readDevices(paths)).toEqual([]);
    const { device } = await pairDevice(url, offer);
    await device.control.request("host.info");
    expect(host.status().devices.map((entry) => entry.name)).toEqual(["iPhone"]);
  });

  it("closes a handshake that never completes and a malformed hello", async () => {
    const { url } = await startHost({ handshakeTimeoutMs: 80 });
    const silent = new WebSocket(url);
    const silentClose = new Promise<[number, string]>((resolve) => silent.once("close", (code, reason) => resolve([code, reason.toString()])));
    await new Promise((resolve) => silent.once("open", resolve));
    expect(await silentClose).toEqual([4403, "bad-handshake"]);
    const garbage = new WebSocket(url);
    const garbageClose = new Promise<[number, string]>((resolve) => garbage.once("close", (code, reason) => resolve([code, reason.toString()])));
    garbage.once("open", () => garbage.send(Uint8Array.of(0x09, 1, 2, 3)));
    expect(await garbageClose).toEqual([4403, "bad-handshake"]);
  });

  it("closes the sessions of a revoked device", async () => {
    const { host, url, paths } = await startHost();
    const offer = await parseOfferLink((await host.createOffer()).link);
    const { device, key } = await pairDevice(url, offer);
    await device.control.request("host.info");
    expect(host.revoke("iphone")).toMatchObject({ name: "iPhone" });
    expect(await device.closed).toEqual({ code: 4403, reason: "revoked" });
    expect(device.session.closed).toBe(true);
    await until(async () => (await readDevices(paths)).length === 0);
    const back = connectDevice(url, { deviceKey: key, name: "iPhone", hostKey: base64urlDecode(offer.x) });
    expect(await rejection(back)).toEqual({ code: 4403, reason: "unknown-device" });
    expect(() => host.revoke("iPhone")).toThrow('No paired device matches "iPhone"');
  });

  it("advertises the host as _oxbit-remote._tcp on its LAN port", async () => {
    const ads: unknown[] = [];
    const { host } = await startHost({ advertise: (ad) => (ads.push(ad), { instance: "x", close: async () => {} }) });
    expect(ads).toEqual([{ id: host.id, name: "Studio Mac", version: expect.any(String), port: host.status().lan.port, service: "_oxbit-remote._tcp" }]);
  });

  it("answers ping on the LAN socket", async () => {
    const { url } = await startHost();
    const socket = new WebSocket(url);
    cleanup.push(async () => socket.close());
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send("ping");
    const [data] = await new Promise<[Buffer]>((resolve) => socket.once("message", (...args) => resolve(args as unknown as [Buffer])));
    expect(data.toString()).toBe("pong");
  });
});
