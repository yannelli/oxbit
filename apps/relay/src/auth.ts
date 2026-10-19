import { base64UrlToBytes, bytesToBase64Url, SIGNING_PREFIX, utf8 } from "./protocol.js";

const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

/** First 22 characters of base64url(SHA-256(raw Ed25519 public key)). */
export async function hostIdFor(publicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey));
  return bytesToBase64Url(digest).slice(0, 22);
}

export function signedChallenge(hostId: string, nonce: string): Uint8Array<ArrayBuffer> {
  return utf8(`${SIGNING_PREFIX}:${hostId}:${nonce}`);
}

/** `key` and `sig` are base64url. True when the key hashes to `hostId` and signs the challenge. */
export async function verifyHostAuth(hostId: string, nonce: string, key: string, sig: string): Promise<boolean> {
  const rawKey = base64UrlToBytes(key);
  const signature = base64UrlToBytes(sig);
  if (rawKey?.byteLength !== PUBLIC_KEY_BYTES || signature?.byteLength !== SIGNATURE_BYTES) return false;
  if ((await hostIdFor(rawKey)) !== hostId) return false;
  try {
    const publicKey = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, signedChallenge(hostId, nonce));
  } catch {
    return false;
  }
}
