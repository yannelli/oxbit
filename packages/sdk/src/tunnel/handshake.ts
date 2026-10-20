import { base64urlDecode, concatBytes, utf8Decode, utf8Encode, type Bytes } from "./encoding.js";
import { deviceIdFromKey, type KeyPair } from "./keys.js";
import { HandshakeState, type NoisePattern, type TransportCiphers } from "./noise-handshake.js";
import type { Offer } from "./offer.js";

export const TUNNEL_PROLOGUE = "oxbit-tunnel-v1";
export const MODE_BYTES: Record<NoisePattern, number> = { IK: 0x01, IKpsk2: 0x02 };

/** Message 1 payload. `offer` is present in IKpsk2 only. */
export interface DeviceHello {
  v: 1;
  name: string;
  offer?: string;
}
/** Message 2 payload. */
export interface HostHello {
  v: 1;
  id: string;
  name: string;
}

interface CommonOptions {
  /** Device X25519 key pair. */
  deviceKey: KeyPair;
  /** Device display name sent to the host. */
  name: string;
  ephemeral?: KeyPair;
  prologue?: Uint8Array;
}
/** With `offer`, pairs with IKpsk2 using the offer's keys; with `hostKey`, reconnects a paired device with IK. */
export type InitiatorOptions = CommonOptions & ({ offer: Offer; hostKey?: undefined } | { hostKey: Uint8Array; offer?: undefined });

export interface ResponderOptions {
  /** Host X25519 static key pair. */
  hostKey: KeyPair;
  ephemeral?: KeyPair;
  prologue?: Uint8Array;
}

function parseJson(bytes: Uint8Array, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch {
    value = undefined;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`Invalid ${what} payload`);
}

function parseHostHello(bytes: Uint8Array): HostHello {
  const value = parseJson(bytes, "host hello");
  if (value.v !== 1 || typeof value.id !== "string" || typeof value.name !== "string") throw new Error("Invalid host hello payload");
  return { v: 1, id: value.id, name: value.name };
}

function parseDeviceHello(bytes: Uint8Array, pattern: NoisePattern): DeviceHello {
  const value = parseJson(bytes, "device hello");
  if (value.v !== 1 || typeof value.name !== "string") throw new Error("Invalid device hello payload");
  if (pattern === "IK") return { v: 1, name: value.name };
  if (typeof value.offer !== "string") throw new Error("Device hello is missing the offer id");
  return { v: 1, name: value.name, offer: value.offer };
}

const prologueOf = (prologue?: Uint8Array) => prologue ?? utf8Encode(TUNNEL_PROLOGUE);

/** Device side. Send `message`, then pass the host's first binary message to `finish`. */
export class InitiatorHandshake {
  private constructor(
    private readonly state: HandshakeState,
    readonly pattern: NoisePattern,
    /** `[mode byte][Noise message 1]`. */
    readonly message: Bytes,
  ) {}

  static async start(options: InitiatorOptions): Promise<InitiatorHandshake> {
    const pattern: NoisePattern = options.offer ? "IKpsk2" : "IK";
    const state = await HandshakeState.create({
      pattern,
      initiator: true,
      prologue: prologueOf(options.prologue),
      staticKey: options.deviceKey,
      remoteStatic: options.offer ? base64urlDecode(options.offer.x) : options.hostKey,
      ephemeral: options.ephemeral,
      psk: options.offer ? base64urlDecode(options.offer.k) : undefined,
    });
    const hello: DeviceHello = options.offer ? { v: 1, name: options.name, offer: options.offer.o } : { v: 1, name: options.name };
    const noise = await state.writeMessage(utf8Encode(JSON.stringify(hello)));
    return new InitiatorHandshake(state, pattern, concatBytes(Uint8Array.of(MODE_BYTES[pattern]), noise));
  }

  /** Throws when message 2 fails authentication, which includes a wrong psk. */
  async finish(reply: Uint8Array): Promise<{ ciphers: TransportCiphers; host: HostHello }> {
    const host = parseHostHello(await this.state.readMessage(reply));
    return { ciphers: await this.state.split(), host };
  }
}

/** Host side. Inspect `deviceKey` and `device` before calling `reply`. */
export class ResponderHandshake {
  private constructor(
    private readonly state: HandshakeState,
    readonly pattern: NoisePattern,
    /** Device X25519 static public key. */
    readonly deviceKey: Bytes,
    readonly device: DeviceHello,
  ) {}

  /** `deviceIdFromKey(deviceKey)`. */
  get deviceId(): string {
    return deviceIdFromKey(this.deviceKey);
  }

  /** Reads `[mode byte][Noise message 1]`; throws on an unknown mode or a bad message. */
  static async accept(message: Uint8Array, options: ResponderOptions): Promise<ResponderHandshake> {
    const pattern = (Object.keys(MODE_BYTES) as NoisePattern[]).find((key) => MODE_BYTES[key] === message[0]);
    if (!pattern) throw new Error("Unknown tunnel handshake mode");
    const state = await HandshakeState.create({
      pattern,
      initiator: false,
      prologue: prologueOf(options.prologue),
      staticKey: options.hostKey,
      ephemeral: options.ephemeral,
    });
    const device = parseDeviceHello(await state.readMessage(message.subarray(1)), pattern);
    return new ResponderHandshake(state, pattern, state.remoteStatic!, device);
  }

  /** Writes message 2. IKpsk2 needs the psk of the offer named in `device.offer`. */
  async reply(host: HostHello, psk?: Uint8Array): Promise<{ message: Bytes; ciphers: TransportCiphers }> {
    if ((this.pattern === "IKpsk2") !== (psk !== undefined)) throw new Error(`${this.pattern} ${psk ? "takes no" : "needs a"} psk`);
    this.state.psk = psk;
    const message = await this.state.writeMessage(utf8Encode(JSON.stringify(host)));
    return { message, ciphers: await this.state.split() };
  }
}
