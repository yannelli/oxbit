import { hostIdFor, signedChallenge } from "../src/auth.js";
import type { DurableState, RelaySocket } from "../src/cloudflare.js";
import { HostRelay } from "../src/host-object.js";
import { bytesToBase64Url, LIMITS, type Limits } from "../src/protocol.js";

export const START = Date.UTC(2026, 9, 19, 12, 0, 0);

export class FakeSocket implements RelaySocket {
  readyState = 1;
  tags: string[] = [];
  accepted = false;
  sent: (string | Uint8Array)[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = null;

  accept(): void {
    this.accepted = true;
  }

  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data.slice(0)));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) throw new Error("already closed");
    this.closed = { code, reason };
    this.readyState = 2;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  /** JSON text frames sent to the peer. */
  messages(): unknown[] {
    return this.sent.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item));
  }

  binaries(): Uint8Array[] {
    return this.sent.filter((item): item is Uint8Array => typeof item !== "string");
  }
}

export class FakeState implements DurableState {
  readonly sockets: FakeSocket[] = [];
  readonly values = new Map<string, unknown>();
  readonly pending: Promise<unknown>[] = [];
  alarm: number | null = null;
  puts = 0;
  autoResponse: unknown;

  readonly storage = {
    get: async <T>(key: string) => structuredClone(this.values.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      this.puts += 1;
      this.values.set(key, structuredClone(value));
    },
    getAlarm: async () => this.alarm,
    setAlarm: async (time: number) => {
      this.alarm = time;
    },
  };

  acceptWebSocket(socket: RelaySocket, tags: string[] = []): void {
    const fake = socket as FakeSocket;
    fake.tags = tags;
    fake.accepted = true;
    this.sockets.push(fake);
  }

  getWebSockets(tag?: string): RelaySocket[] {
    return this.sockets.filter((socket) => socket.readyState !== 3 && (tag === undefined || socket.tags.includes(tag)));
  }

  setWebSocketAutoResponse(pair?: unknown): void {
    this.autoResponse = pair;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const promise = callback();
    this.pending.push(promise);
    return promise;
  }
}

export interface HostKeys {
  id: string;
  key: string;
  raw: Uint8Array;
  sign(hostId: string, nonce: string): Promise<string>;
}

export async function hostKeys(): Promise<HostKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    id: await hostIdFor(raw),
    key: bytesToBase64Url(raw),
    raw,
    sign: async (hostId, nonce) =>
      bytesToBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, signedChallenge(hostId, nonce)))),
  };
}

/** One host id's Durable Object over fake sockets, storage and clock. `wake()` simulates hibernation. */
export class Harness {
  now = START;
  readonly state = new FakeState();
  readonly limits: Limits;
  relay: HostRelay;
  private counter = 0;
  private lastServer: FakeSocket | null = null;

  constructor(
    readonly keys: HostKeys,
    limits: Partial<Limits> = {},
  ) {
    this.limits = { ...LIMITS, ...limits };
    this.relay = this.wake();
  }

  wake(): HostRelay {
    this.relay = new HostRelay(this.state, {
      now: () => this.now,
      randomBytes: (length) => {
        this.counter += 1;
        return Uint8Array.from({ length }, (_, index) => (this.counter * 37 + index) & 0xff);
      },
      socketPair: () => {
        this.lastServer = new FakeSocket();
        return [new FakeSocket(), this.lastServer];
      },
      upgrade: () => new Response(null, { status: 200 }),
      autoResponse: () => ({ request: "ping", response: "pong" }),
      limits: this.limits,
    });
    return this.relay;
  }

  async ready(): Promise<void> {
    await Promise.all(this.state.pending);
  }

  async open(path: "/v1/host" | "/v1/connect"): Promise<FakeSocket> {
    await this.ready();
    await this.relay.fetch(new Request(`https://relay.test${path}?id=${this.keys.id}`, { headers: { Upgrade: "websocket" } }));
    return this.lastServer!;
  }

  async host(keys: HostKeys = this.keys): Promise<FakeSocket> {
    const socket = await this.open("/v1/host");
    const { nonce } = socket.messages()[0] as { nonce: string };
    await this.text(socket, { t: "auth", key: keys.key, sig: await keys.sign(this.keys.id, nonce) });
    return socket;
  }

  /** Opens a device and returns it with the connection id the host saw. */
  async device(host: FakeSocket): Promise<{ socket: FakeSocket; c: string }> {
    const socket = await this.open("/v1/connect");
    const open = host.messages().at(-1) as { t: string; c: string };
    return { socket, c: open.t === "open" ? open.c : "" };
  }

  async establish(host: FakeSocket): Promise<{ socket: FakeSocket; c: string }> {
    const device = await this.device(host);
    await this.text(host, { t: "established", c: device.c });
    return device;
  }

  async text(socket: FakeSocket, message: unknown): Promise<void> {
    await this.ready();
    await this.relay.webSocketMessage(socket, typeof message === "string" ? message : JSON.stringify(message));
  }

  async binary(socket: FakeSocket, bytes: Uint8Array): Promise<void> {
    await this.ready();
    await this.relay.webSocketMessage(socket, bytes.slice().buffer);
  }

  /** The peer closes the socket. */
  async peerClose(socket: FakeSocket): Promise<void> {
    socket.readyState = 3;
    await this.relay.webSocketClose(socket, 1000, "", true);
  }

  /** Moves the clock forward, running each alarm that falls due. */
  async advance(ms: number): Promise<void> {
    await this.ready();
    const target = this.now + ms;
    while (this.state.alarm !== null && this.state.alarm <= target) {
      this.now = this.state.alarm;
      this.state.alarm = null;
      await this.relay.alarm();
    }
    this.now = target;
  }
}
