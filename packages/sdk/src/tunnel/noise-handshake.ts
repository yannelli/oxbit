import { concatBytes, type Bytes } from "./encoding.js";
import { generateX25519KeyPair, KEY_BYTES, x25519, type KeyPair } from "./keys.js";
import { CipherState, MAX_NOISE_MESSAGE, SymmetricState, TAG_BYTES } from "./noise-cipher.js";

export type NoisePattern = "IK" | "IKpsk2";
export const NOISE_PROTOCOLS: Record<NoisePattern, string> = {
  IK: "Noise_IK_25519_AESGCM_SHA256",
  IKpsk2: "Noise_IKpsk2_25519_AESGCM_SHA256",
};
type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";
const MESSAGES: Record<NoisePattern, Token[][]> = {
  IK: [["e", "es", "s", "ss"], ["e", "ee", "se"]],
  IKpsk2: [["e", "es", "s", "ss"], ["e", "ee", "se", "psk"]],
};
const EMPTY = new Uint8Array(0);

export interface HandshakeOptions {
  pattern: NoisePattern;
  initiator: boolean;
  prologue: Uint8Array;
  staticKey: KeyPair;
  /** Responder static public key (`<- s` pre-message); required for the initiator. */
  remoteStatic?: Uint8Array;
  /** Fixed ephemeral key for replaying test vectors; generated when absent. */
  ephemeral?: KeyPair;
  /** Pre-shared key for the `psk` token; may also be set on `HandshakeState.psk` before that token. */
  psk?: Uint8Array;
}

/** Transport cipher states after Split, oriented for this side. */
export interface TransportCiphers {
  send: CipherState;
  receive: CipherState;
  handshakeHash: Bytes;
}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Noise handshake is missing ${name}`);
  return value;
}

/** Noise HandshakeState (spec section 5.3) for the IK and IKpsk2 patterns. */
export class HandshakeState {
  psk?: Uint8Array;
  remoteStatic?: Bytes;
  private remoteEphemeral?: Bytes;
  private ephemeral?: KeyPair;
  private index = 0;

  private constructor(
    private readonly symmetric: SymmetricState,
    private readonly options: HandshakeOptions,
  ) {
    this.psk = options.psk;
    if (options.remoteStatic) this.remoteStatic = Uint8Array.from(options.remoteStatic);
  }

  static async create(options: HandshakeOptions): Promise<HandshakeState> {
    const { initiator, remoteStatic, staticKey } = options;
    if (initiator && remoteStatic?.length !== KEY_BYTES) throw new Error("Noise initiator needs the responder's 32-byte static key");
    const symmetric = await SymmetricState.create(NOISE_PROTOCOLS[options.pattern]);
    await symmetric.mixHash(options.prologue);
    await symmetric.mixHash(initiator ? remoteStatic! : staticKey.publicKey);
    return new HandshakeState(symmetric, options);
  }

  get isComplete(): boolean {
    return this.index === MESSAGES[this.options.pattern].length;
  }

  get handshakeHash(): Bytes {
    return this.symmetric.handshakeHash;
  }

  private get usesPsk(): boolean {
    return this.options.pattern.includes("psk");
  }

  private nextTokens(writing: boolean): Token[] {
    const messages = MESSAGES[this.options.pattern];
    if (this.isComplete) throw new Error("Noise handshake is already complete");
    const initiatorTurn = this.index % 2 === 0;
    if (writing !== (initiatorTurn === this.options.initiator)) throw new Error(`Noise handshake expects to ${writing ? "read" : "write"} next`);
    return messages[this.index++];
  }

  async writeMessage(payload: Uint8Array = EMPTY): Promise<Bytes> {
    const parts: Uint8Array[] = [];
    for (const token of this.nextTokens(true)) {
      if (token === "e") {
        this.ephemeral = this.options.ephemeral ?? (await generateX25519KeyPair());
        parts.push(this.ephemeral.publicKey);
        await this.mixEphemeral(this.ephemeral.publicKey);
      } else if (token === "s") {
        parts.push(await this.symmetric.encryptAndHash(this.options.staticKey.publicKey));
      } else {
        await this.mixToken(token);
      }
    }
    parts.push(await this.symmetric.encryptAndHash(payload));
    const message = concatBytes(...parts);
    if (message.length > MAX_NOISE_MESSAGE) throw new Error("Noise message exceeds 65535 bytes");
    return message;
  }

  /** Returns the decrypted payload; throws on a malformed or unauthentic message. */
  async readMessage(message: Uint8Array): Promise<Bytes> {
    if (message.length > MAX_NOISE_MESSAGE) throw new Error("Noise message exceeds 65535 bytes");
    let offset = 0;
    const take = (length: number) => {
      if (offset + length > message.length) throw new Error("Noise message is too short");
      return Uint8Array.from(message.subarray(offset, (offset += length)));
    };
    for (const token of this.nextTokens(false)) {
      if (token === "e") {
        this.remoteEphemeral = take(KEY_BYTES);
        await this.mixEphemeral(this.remoteEphemeral);
      } else if (token === "s") {
        this.remoteStatic = await this.symmetric.decryptAndHash(take(KEY_BYTES + (this.symmetric.cipher.hasKey ? TAG_BYTES : 0)));
      } else {
        await this.mixToken(token);
      }
    }
    return this.symmetric.decryptAndHash(message.subarray(offset));
  }

  async split(): Promise<TransportCiphers> {
    if (!this.isComplete) throw new Error("Noise handshake is not complete");
    const [initiatorToResponder, responderToInitiator] = await this.symmetric.split();
    const handshakeHash = this.handshakeHash;
    return this.options.initiator
      ? { send: initiatorToResponder, receive: responderToInitiator, handshakeHash }
      : { send: responderToInitiator, receive: initiatorToResponder, handshakeHash };
  }

  private async mixEphemeral(publicKey: Uint8Array): Promise<void> {
    await this.symmetric.mixHash(publicKey);
    if (this.usesPsk) await this.symmetric.mixKey(publicKey);
  }

  private async mixToken(token: Exclude<Token, "e" | "s">): Promise<void> {
    if (token === "psk") {
      if (this.psk?.length !== KEY_BYTES) throw new Error("Noise psk must be 32 bytes");
      return this.symmetric.mixKeyAndHash(this.psk);
    }
    const e = () => need(this.ephemeral, "the local ephemeral key").privateKey;
    const s = () => this.options.staticKey.privateKey;
    const re = () => need(this.remoteEphemeral, "the remote ephemeral key");
    const rs = () => need(this.remoteStatic, "the remote static key");
    const initiator = this.options.initiator;
    const [local, remote] =
      token === "ee" ? [e(), re()]
      : token === "ss" ? [s(), rs()]
      : (token === "es") === initiator ? [e(), rs()]
      : [s(), re()];
    await this.symmetric.mixKey(await x25519(local, remote));
  }
}
