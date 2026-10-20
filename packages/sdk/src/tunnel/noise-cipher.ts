import { concatBytes, utf8Encode, type Bytes } from "./encoding.js";
import { sha256 } from "./keys.js";

export const HASH_BYTES = 32;
export const TAG_BYTES = 16;
/** Largest Noise message, handshake or transport. */
export const MAX_NOISE_MESSAGE = 65535;
const MAX_NONCE = 2n ** 64n - 1n;
const EMPTY = new Uint8Array(0);

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const hmacKey = await crypto.subtle.importKey("raw", key as Bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, data as Bytes));
}

/** Noise HKDF (spec section 4.3) with HMAC-SHA256; returns `outputs` keys of 32 bytes. */
export async function hkdf(chainingKey: Uint8Array, input: Uint8Array, outputs: 2 | 3): Promise<Bytes[]> {
  const tempKey = await hmac(chainingKey, input);
  const out: Bytes[] = [];
  let previous: Uint8Array = EMPTY;
  for (let i = 1; i <= outputs; i++) {
    previous = await hmac(tempKey, concatBytes(previous, Uint8Array.of(i)));
    out.push(previous as Bytes);
  }
  return out;
}

/** AESGCM cipher with a 64-bit counter nonce; encrypts in the clear until a key is set. */
export class CipherState {
  private key?: CryptoKey;
  private nonce = 0n;

  static async create(key?: Uint8Array): Promise<CipherState> {
    const state = new CipherState();
    if (key) await state.initializeKey(key);
    return state;
  }

  get hasKey(): boolean {
    return this.key !== undefined;
  }

  async initializeKey(key: Uint8Array): Promise<void> {
    this.key = await crypto.subtle.importKey("raw", key as Bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    this.nonce = 0n;
  }

  private nextIv(): Bytes {
    if (this.nonce >= MAX_NONCE) throw new Error("Noise nonce exhausted");
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, this.nonce);
    return iv;
  }

  async encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
    if (!this.key) return Uint8Array.from(plaintext);
    const iv = this.nextIv();
    this.nonce++;
    const params = { name: "AES-GCM", iv, additionalData: ad as Bytes, tagLength: 128 };
    return new Uint8Array(await crypto.subtle.encrypt(params, this.key, plaintext as Bytes));
  }

  /** Throws on authentication failure and leaves the nonce unchanged. */
  async decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Promise<Bytes> {
    if (!this.key) return Uint8Array.from(ciphertext);
    const iv = this.nextIv();
    const params = { name: "AES-GCM", iv, additionalData: ad as Bytes, tagLength: 128 };
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(params, this.key, ciphertext as Bytes);
    } catch {
      throw new Error("Noise message failed authentication");
    }
    this.nonce++;
    return new Uint8Array(plaintext);
  }
}

export class SymmetricState {
  readonly cipher = new CipherState();
  private constructor(
    private chainingKey: Bytes,
    private hash: Bytes,
  ) {}

  static async create(protocolName: string): Promise<SymmetricState> {
    const name = utf8Encode(protocolName);
    const h = name.length <= HASH_BYTES ? concatBytes(name, new Uint8Array(HASH_BYTES - name.length)) : await sha256(name);
    return new SymmetricState(h, Uint8Array.from(h));
  }

  get handshakeHash(): Bytes {
    return Uint8Array.from(this.hash);
  }

  async mixKey(input: Uint8Array): Promise<void> {
    const [chainingKey, key] = await hkdf(this.chainingKey, input, 2);
    this.chainingKey = chainingKey;
    await this.cipher.initializeKey(key);
  }

  async mixHash(data: Uint8Array): Promise<void> {
    this.hash = await sha256(concatBytes(this.hash, data));
  }

  async mixKeyAndHash(input: Uint8Array): Promise<void> {
    const [chainingKey, hash, key] = await hkdf(this.chainingKey, input, 3);
    this.chainingKey = chainingKey;
    await this.mixHash(hash);
    await this.cipher.initializeKey(key);
  }

  async encryptAndHash(plaintext: Uint8Array): Promise<Bytes> {
    const ciphertext = await this.cipher.encryptWithAd(this.hash, plaintext);
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  async decryptAndHash(ciphertext: Uint8Array): Promise<Bytes> {
    const plaintext = await this.cipher.decryptWithAd(this.hash, ciphertext);
    await this.mixHash(ciphertext);
    return plaintext;
  }

  /** Returns the initiator-to-responder and responder-to-initiator cipher states. */
  async split(): Promise<[CipherState, CipherState]> {
    const [k1, k2] = await hkdf(this.chainingKey, EMPTY, 2);
    return [await CipherState.create(k1), await CipherState.create(k2)];
  }
}
