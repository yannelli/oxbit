import { describe, expect, it, vi } from "vitest";
import {
  ControlChannel,
  ResponderHandshake,
  TunnelSession,
  base64urlDecode,
  createOffer,
  deviceIdFromKey,
  exportKeyPair,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  offerLink,
  type KeyPair,
  type Offer,
} from "@oxbit/sdk/tunnel";
import { RemoteHost } from "./remote.js";
import { dialTargets, type DialSocket } from "./remote-dial.js";
import { loadDeviceKey, readPairingLink, type PairedHost, type RemoteHostOptions } from "./remote-records.js";

/** In-memory WebSocket; the fake host reads what the device sends through `peer`. */
class FakeSocket {
  binaryType: BinaryType = "blob";
  onopen: DialSocket["onopen"] = null;
  onmessage: DialSocket["onmessage"] = null;
  onerror: DialSocket["onerror"] = null;
  onclose: DialSocket["onclose"] = null;
  peer?: (bytes: Uint8Array) => void;
  closed?: { code: number; reason: string };
  constructor(readonly url: string) {}
  send(data: Uint8Array) {
    this.peer?.(Uint8Array.from(data));
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
    queueMicrotask(() => this.onclose?.call(this as never, { code, reason } as CloseEvent));
  }
  deliver(bytes: Uint8Array) {
    if (!this.closed) this.onmessage?.call(this as never, { data: bytes.slice().buffer } as MessageEvent);
  }
  open() {
    queueMicrotask(() => this.onopen?.call(this as never, {} as Event));
  }
}

/** A host built from the tunnel library: device list, pending offers, and the control methods. */
class FakeHost {
  online = true;
  readonly devices = new Set<string>();
  readonly offers = new Map<string, Uint8Array>();
  readonly modes: number[] = [];
  readonly sessions: TunnelSession[] = [];
  readonly opened: { path: string; stream: number; token: string }[] = [];
  readonly runtime: { stream: number; message: { id: string; method: string; params: Record<string, unknown> } }[] = [];
  private constructor(
    readonly id: string,
    private readonly key: KeyPair,
    readonly offer: Offer,
  ) {}

  static async create() {
    const key = await generateX25519KeyPair();
    const offer = await createOffer({ admissionKey: (await generateEd25519KeyPair()).publicKey, staticKey: key.publicKey, name: "Studio Mac", relay: "wss://relay.test", lan: ["192.168.1.2:7000"] });
    const host = new FakeHost(offer.h, key, offer);
    host.offers.set(offer.o, base64urlDecode(offer.k));
    return host;
  }

  /** What the relay's device socket would do: refuse with 4404 while the host is away, otherwise forward frames. */
  accept(socket: FakeSocket) {
    socket.open();
    if (!this.online) return void queueMicrotask(() => socket.close(4404, "host offline"));
    let session: TunnelSession | undefined;
    socket.peer = (bytes) => {
      if (session) return void session.receive(bytes);
      void this.handshake(socket, bytes).then((value) => (session = value));
    };
  }

  private async handshake(socket: FakeSocket, bytes: Uint8Array): Promise<TunnelSession | undefined> {
    this.modes.push(bytes[0]);
    const responder = await ResponderHandshake.accept(bytes, { hostKey: this.key });
    const psk = responder.device.offer ? this.offers.get(responder.device.offer) : undefined;
    if (responder.pattern === "IKpsk2" && !psk) return void socket.close(4403, "offer-expired");
    if (responder.pattern === "IK" && !this.devices.has(responder.deviceId)) return void socket.close(4403, "unknown-device");
    const reply = await responder.reply({ v: 1, id: this.id, name: "Studio Mac" }, psk);
    const session = new TunnelSession(reply.ciphers, { send: (data) => socket.deliver(data), close: () => socket.close() });
    const paired = session.on("message", () => {
      paired();
      this.devices.add(responder.deviceId);
      if (responder.device.offer) this.offers.delete(responder.device.offer);
    });
    this.serve(session);
    this.sessions.push(session);
    socket.deliver(reply.message);
    return session;
  }

  private serve(session: TunnelSession) {
    const control = new ControlChannel(session);
    control.handle("host.info", () => ({ id: this.id, name: "Studio Mac", version: "1.0.0", platform: "darwin", home: "/Users/dev" }));
    control.handle("host.open", ({ path }: { path: string }) => {
      const stream = 10 + this.opened.length;
      this.opened.push({ path, stream, token: `token-${stream}` });
      return { stream, token: `token-${stream}`, runtime: { id: "runtime-1", name: "Studio Mac", version: "1.0.0" }, workspace: { root: path, name: "app" } };
    });
    session.on("message", (stream, text) => {
      if (stream === 0) return;
      const message = JSON.parse(text);
      this.runtime.push({ stream, message });
      const issued = this.opened.find((item) => item.stream === stream)?.token;
      const reply = message.method !== "auth.authenticate" ? { result: {} }
        : message.params.token === issued ? { result: { workspaceId: "w1", capabilities: [], trusted: false, owner: true, workspaceName: "app" } }
        : { error: { code: "UNAUTHORIZED", message: "Unknown token" } };
      void session.send(stream, JSON.stringify({ v: 1, type: "response", id: message.id, ...reply }));
    });
  }
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 2000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
}

async function setup(reachable: (url: string) => boolean = (url) => url.startsWith("wss:")) {
  const host = await FakeHost.create();
  const urls: string[] = [];
  const records: PairedHost[] = [];
  const options: RemoteHostOptions = {
    deviceKey: await generateX25519KeyPair(),
    deviceName: "iPhone",
    heartbeatMs: 0,
    retryMs: [5],
    onRecord: (record) => records.push(record),
    webSocket: (url) => {
      urls.push(url);
      const socket = new FakeSocket(url);
      if (reachable(url)) host.accept(socket);
      else queueMicrotask(() => socket.close(1006, ""));
      return socket;
    },
  };
  return { host, urls, records, options };
}

describe("RemoteHost", () => {
  it("pairs with IKpsk2 and reconnects with IK after the tunnel drops", async () => {
    const { host, urls, records, options } = await setup();
    const remote = await RemoteHost.pair(await readPairingLink(offerLink(host.offer)), options);
    expect(host.modes).toEqual([0x02]);
    expect(host.devices.has(deviceIdFromKey(options.deviceKey.publicKey))).toBe(true);
    expect(host.offers.size).toBe(0);
    expect(remote.status()).toMatchObject({ state: "online", via: "relay" });
    expect(records.at(-1)).toMatchObject({ id: host.id, name: "Studio Mac", key: host.offer.x, relay: "wss://relay.test", lan: ["192.168.1.2:7000"] });
    expect(urls.at(-1)).toBe(`wss://relay.test/v1/connect?id=${host.id}`);

    host.sessions[0].close("restart");
    await until(() => host.modes.length === 2 && remote.status().state === "online");
    expect(host.modes).toEqual([0x02, 0x01]);
    expect((await remote.info()).home).toBe("/Users/dev");
    remote.dispose();
  });

  it("reports an offline host with its last-seen time and connects when it returns", async () => {
    const { host, options } = await setup();
    host.devices.add(deviceIdFromKey(options.deviceKey.publicKey));
    host.online = false;
    const remote = new RemoteHost({ id: host.id, name: "Studio Mac", key: host.offer.x, relay: "wss://relay.test", pairedAt: 1, lastSeen: 1234 }, options);
    await expect(remote.connect()).rejects.toMatchObject({ code: "offline", message: "Studio Mac is offline." });
    expect(remote.status()).toMatchObject({ state: "offline", lastSeen: 1234 });
    host.online = true;
    await until(() => remote.status().state === "online");
    expect(remote.status().lastSeen).toBeGreaterThan(1234);
    remote.dispose();
  });

  it("explains an expired pairing link and a device the host removed", async () => {
    const { host, options } = await setup();
    host.offers.clear();
    await expect(RemoteHost.pair(host.offer, options)).rejects.toThrow("This pairing link expired. Run oxbit remote pair on your computer for a new one.");
    const remote = new RemoteHost({ id: host.id, name: "Studio Mac", key: host.offer.x, relay: "wss://relay.test", pairedAt: 1 }, options);
    await expect(remote.connect()).rejects.toMatchObject({ code: "removed" });
    expect(remote.status().state).toBe("failed");
    remote.dispose();
  });

  it("tries Bonjour, then the link's LAN addresses, then the relay", async () => {
    const { host, urls, options } = await setup();
    host.devices.add(deviceIdFromKey(options.deviceKey.publicKey));
    const remote = new RemoteHost({ id: host.id, name: "Studio Mac", key: host.offer.x, relay: "wss://relay.test/", lan: ["192.168.1.2:7000"], pairedAt: 1 },
      { ...options, bonjour: () => ["10.0.0.5:7000", "192.168.1.2:7000"] });
    await remote.connect();
    expect(urls).toEqual(["ws://10.0.0.5:7000/v1/connect", "ws://192.168.1.2:7000/v1/connect", `wss://relay.test/v1/connect?id=${host.id}`]);
    remote.dispose();
    expect(dialTargets({ id: "h", relay: "wss://r.test", lan: ["10.0.0.5:1"] }, [])).toMatchObject([{ via: "lan", timeoutMs: 2500 }, { via: "relay" }]);
  });

  it("uses the LAN when the host answers there", async () => {
    const { host, urls, options } = await setup((url) => url.startsWith("ws://192.168.1.2"));
    const remote = await RemoteHost.pair(host.offer, options);
    expect(remote.status().via).toBe("lan");
    expect(urls).toEqual(["ws://192.168.1.2:7000/v1/connect"]);
    remote.dispose();
  });

  it("opens a folder as a runtime client that authenticates with the host's token first", async () => {
    const { host, options } = await setup();
    const remote = await RemoteHost.pair(host.offer, options);
    const client = await remote.connectRuntime("/Users/dev/app");
    expect(host.opened).toEqual([{ path: "/Users/dev/app", stream: 10, token: "token-10" }]);
    expect(host.runtime[0]).toMatchObject({ stream: 10, message: { method: "auth.authenticate", params: { token: "token-10" } } });
    expect(client).toMatchObject({ connected: true, url: `oxbit-remote://${host.id}`, session: { workspaceName: "app", trusted: false } });

    host.sessions[0].close("restart");
    await until(() => client.connected && host.opened.length === 2);
    expect(host.runtime.find((item) => item.stream === 11)).toMatchObject({ message: { method: "auth.authenticate", params: { token: "token-11" } } });
    client.dispose();
    remote.dispose();
  });
});

describe("device key", () => {
  it("creates and saves a key once, then loads the saved key", async () => {
    let saved: Awaited<ReturnType<typeof exportKeyPair>> | undefined;
    const store = { load: vi.fn(async () => saved), save: vi.fn(async (pair: NonNullable<typeof saved>) => { saved = pair; }) };
    const created = await loadDeviceKey(store);
    const loaded = await loadDeviceKey(store);
    expect(store.save).toHaveBeenCalledOnce();
    expect(loaded.publicKey).toEqual(created.publicKey);
  });

  it("rejects a link that is not a pairing link", async () => {
    await expect(readPairingLink("https://oxbit.dev/c#x=1")).rejects.toThrow("This pairing link is not valid.");
  });
});
