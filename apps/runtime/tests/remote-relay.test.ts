import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  generateX25519KeyPair,
  hostIdFromKey,
  parseOfferLink,
  randomBytes,
  verifyRelayChallenge,
} from "@oxbit/sdk/tunnel";
import { connectDevice } from "./remote-device.js";
import { RemoteHost, type HostOptions } from "../src/remote/host.js";
import { remotePaths } from "../src/remote/state.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await delay(10);
  }
}

/** The relay host and device sockets from docs/remote-access.md, without limits. */
async function fakeRelay() {
  const relay = {
    hostSockets: 0,
    host: undefined as WebSocket | undefined,
    devices: new Map<string, WebSocket>(),
    established: [] as string[],
    closes: [] as Array<{ c: string; reason: string }>,
    url: "",
  };
  const server = http.createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const json = (socket: WebSocket, message: object) => socket.send(JSON.stringify(message));
  const onHost = (socket: WebSocket, id: string) => {
    relay.hostSockets++;
    const nonce = base64urlEncode(randomBytes(32));
    json(socket, { t: "challenge", nonce });
    socket.on("message", async (data: Buffer, binary) => {
      if (binary) return relay.devices.get(base64urlEncode(data.subarray(0, 16)))?.send(data.subarray(16));
      const message = JSON.parse(data.toString());
      if (message.t === "auth") {
        const key = base64urlDecode(message.key);
        if ((await hostIdFromKey(key)) !== id || !(await verifyRelayChallenge(key, id, nonce, message.sig))) return socket.close(4401);
        relay.host = socket;
        json(socket, { t: "ready" });
      } else if (message.t === "established") relay.established.push(message.c);
      else if (message.t === "close") {
        relay.closes.push({ c: message.c, reason: message.reason });
        relay.devices.get(message.c)?.close(4403, message.reason);
      }
    });
    socket.on("close", () => {
      if (relay.host === socket) relay.host = undefined;
    });
  };
  const onDevice = (socket: WebSocket) => {
    const host = relay.host;
    if (!host) return socket.close(4404);
    const id = randomBytes(16);
    const c = base64urlEncode(id);
    relay.devices.set(c, socket);
    json(host, { t: "open", c });
    socket.on("message", (data: Buffer, binary) => {
      if (binary) host.send(concatBytes(id, data));
    });
    socket.on("close", () => {
      relay.devices.delete(c);
      if (host.readyState === host.OPEN) json(host, { t: "closed", c });
    });
  };
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://relay");
    sockets.handleUpgrade(request, socket, head, (ws) =>
      url.pathname === "/v1/host" ? onHost(ws, url.searchParams.get("id") ?? "") : url.pathname === "/v1/connect" ? onDevice(ws) : ws.close(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  relay.url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return relay;
}

async function startHost(relayUrl: string, options: Partial<HostOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxr-relay-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "home"));
  const logs: string[] = [];
  const host = await RemoteHost.start({
    paths: remotePaths({ OXBIT_REMOTE_DIR: path.join(directory, "remote") }),
    env: { OXBIT_RELAY: relayUrl },
    home: path.join(directory, "home"),
    name: "Studio Mac",
    launcher: { ensure: () => Promise.reject(new Error("unused")), list: async () => [] },
    log: (line) => logs.push(line),
    advertise: false,
    ipc: false,
    lanHost: "127.0.0.1",
    relayBackoff: { baseMs: 20, maxMs: 80 },
    ...options,
  });
  cleanup.push(() => host.close());
  return { host, logs };
}

describe("remote host through the relay", () => {
  it("authenticates, pairs over IKpsk2, reconnects over IK, and drops a revoked device", async () => {
    const relay = await fakeRelay();
    const { host } = await startHost(relay.url);
    await until(() => host.status().relay.connected);
    expect(relay.host).toBeDefined();
    const offer = await parseOfferLink((await host.createOffer()).link);
    expect(offer.r).toBe(relay.url);
    const deviceUrl = `${relay.url}/v1/connect?id=${host.id}`;
    const deviceKey = await generateX25519KeyPair();

    const paired = await connectDevice(deviceUrl, { deviceKey, name: "iPhone", offer });
    expect(relay.established).toEqual([]);
    expect(await paired.control.request("host.info")).toMatchObject({ id: host.id, name: "Studio Mac" });
    expect(relay.established).toHaveLength(1);
    expect(host.status().devices).toEqual([expect.objectContaining({ name: "iPhone", connected: true })]);
    paired.socket.close();
    await paired.closed;

    const resumed = await connectDevice(deviceUrl, { deviceKey, name: "iPhone", hostKey: base64urlDecode(offer.x) });
    await resumed.control.request("host.info");
    expect(relay.established).toHaveLength(2);
    host.revoke("iPhone");
    expect(await resumed.closed).toEqual({ code: 4403, reason: "revoked" });
    expect(relay.closes.at(-1)).toEqual({ c: relay.established[1], reason: "revoked" });
  });

  it("asks the relay to drop an unknown device", async () => {
    const relay = await fakeRelay();
    const { host } = await startHost(relay.url);
    await until(() => host.status().relay.connected);
    const offer = await parseOfferLink((await host.createOffer()).link);
    const attempt = connectDevice(`${relay.url}/v1/connect?id=${host.id}`, {
      deviceKey: await generateX25519KeyPair(),
      name: "Stranger",
      hostKey: base64urlDecode(offer.x),
    });
    await expect(attempt).rejects.toMatchObject({ code: 4403, reason: "unknown-device" });
    expect(relay.closes.map((entry) => entry.reason)).toEqual(["unknown-device"]);
    expect(relay.established).toEqual([]);
  });

  it("reconnects after the relay drops it", async () => {
    const relay = await fakeRelay();
    const { host, logs } = await startHost(relay.url);
    await until(() => host.status().relay.connected);
    relay.host!.close(1012, "restarting");
    await until(() => relay.hostSockets === 2 && host.status().relay.connected);
    expect(logs.some((line) => line.includes("Relay disconnected (1012 restarting); reconnecting in"))).toBe(true);
  });

  it("stops reconnecting when another host takes the id", async () => {
    const relay = await fakeRelay();
    const { host, logs } = await startHost(relay.url);
    await until(() => host.status().relay.connected);
    relay.host!.close(4409, "replaced");
    await until(() => host.status().relay.state === "replaced");
    await delay(300);
    expect(relay.hostSockets).toBe(1);
    expect(logs.some((line) => line.includes("4409") && line.includes("Stopped reconnecting"))).toBe(true);
  });

  it("keeps retrying with backoff while the relay is unreachable", async () => {
    const relay = await fakeRelay();
    const unused = relay.url.replace(/:\d+$/, ":1");
    const { host, logs } = await startHost(unused);
    await until(() => logs.filter((line) => line.startsWith("Relay disconnected")).length >= 3);
    expect(host.status().relay).toMatchObject({ url: unused, connected: false });
  });
});
