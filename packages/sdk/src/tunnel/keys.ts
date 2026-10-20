import { base64urlDecode, base64urlEncode, bytesEqual, concatBytes, hexDecode, utf8Encode, type Bytes } from "./encoding.js";

export type KeyAlgorithm = "X25519" | "Ed25519";
/** `publicKey` is the raw 32-byte public key. */
export interface KeyPair {
  publicKey: Bytes;
  privateKey: CryptoKey;
}
/** Raw public key and PKCS #8 private key, both base64url, as kept in `host.json` or the Keychain. */
export interface StoredKeyPair {
  publicKey: string;
  privateKey: string;
}

const USAGES: Record<KeyAlgorithm, KeyUsage[]> = { X25519: ["deriveBits"], Ed25519: ["sign"] };
const PKCS8_PREFIX: Record<KeyAlgorithm, string> = {
  X25519: "302e020100300506032b656e04220420",
  Ed25519: "302e020100300506032b657004220420",
};
export const KEY_BYTES = 32;

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as Bytes));
}

async function generateKeyPair(name: KeyAlgorithm): Promise<KeyPair> {
  const usages: KeyUsage[] = name === "X25519" ? ["deriveBits"] : ["sign", "verify"];
  const pair = (await crypto.subtle.generateKey({ name }, true, usages)) as CryptoKeyPair;
  return { publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), privateKey: pair.privateKey };
}

export const generateX25519KeyPair = () => generateKeyPair("X25519");
export const generateEd25519KeyPair = () => generateKeyPair("Ed25519");

async function publicKeyOf(privateKey: CryptoKey): Promise<Bytes> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!jwk.x) throw new Error("Private key export did not include the public key");
  return base64urlDecode(jwk.x);
}

async function importPrivate(name: KeyAlgorithm, pkcs8: Bytes): Promise<KeyPair> {
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name }, true, USAGES[name]);
  return { publicKey: await publicKeyOf(privateKey), privateKey };
}

export async function exportKeyPair(pair: KeyPair): Promise<StoredKeyPair> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKey: base64urlEncode(pair.publicKey), privateKey: base64urlEncode(pkcs8) };
}

/** Throws when the stored public key does not belong to the private key. */
export async function importKeyPair(name: KeyAlgorithm, stored: StoredKeyPair): Promise<KeyPair> {
  const pair = await importPrivate(name, base64urlDecode(stored.privateKey));
  if (!bytesEqual(pair.publicKey, base64urlDecode(stored.publicKey))) throw new Error(`${name} public key does not match its private key`);
  return pair;
}

/** Builds a key pair from a raw 32-byte private key; used to replay fixed keys such as test vectors. */
export async function keyPairFromRawPrivate(name: KeyAlgorithm, raw: Uint8Array): Promise<KeyPair> {
  if (raw.length !== KEY_BYTES) throw new Error(`${name} private key must be 32 bytes`);
  return importPrivate(name, concatBytes(hexDecode(PKCS8_PREFIX[name]), raw));
}

/** X25519 Diffie-Hellman; returns the 32-byte shared secret. */
export async function x25519(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Bytes> {
  if (publicKey.length !== KEY_BYTES) throw new Error("X25519 public key must be 32 bytes");
  const remote = await crypto.subtle.importKey("raw", publicKey as Bytes, { name: "X25519" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: remote }, privateKey, 256));
}

/** First 22 characters of base64url(SHA-256(raw Ed25519 public key)). */
export async function hostIdFromKey(ed25519PublicKey: Uint8Array): Promise<string> {
  if (ed25519PublicKey.length !== KEY_BYTES) throw new Error("Ed25519 public key must be 32 bytes");
  return base64urlEncode(await sha256(ed25519PublicKey)).slice(0, 22);
}

/** base64url of the raw X25519 public key. */
export function deviceIdFromKey(x25519PublicKey: Uint8Array): string {
  return base64urlEncode(x25519PublicKey);
}

/** UTF-8 `oxbit-relay-v1:<hostId>:<nonce>`, the bytes a host signs to authenticate to the relay. */
export function relayChallengeMessage(hostId: string, nonce: string): Bytes {
  return utf8Encode(`oxbit-relay-v1:${hostId}:${nonce}`);
}

/** Returns the base64url Ed25519 signature for the relay's `auth` message. */
export async function signRelayChallenge(privateKey: CryptoKey, hostId: string, nonce: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, relayChallengeMessage(hostId, nonce));
  return base64urlEncode(new Uint8Array(signature));
}

/** Returns false for a bad signature or a malformed key or signature. */
export async function verifyRelayChallenge(publicKey: Uint8Array, hostId: string, nonce: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", publicKey as Bytes, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, base64urlDecode(signature), relayChallengeMessage(hostId, nonce));
  } catch {
    return false;
  }
}
