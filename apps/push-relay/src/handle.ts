import type { PushDeviceRequest } from "@oxbit/sdk";
import { base64ToBytes, bytesToBase64Url, utf8 } from "./base64.js";

export type Device = PushDeviceRequest;

const IV_BYTES = 12;
/** Device tokens are 32 bytes and Live Activity push tokens have been 128; APNs documents no maximum. */
const HEX_TOKEN = /^(?:[0-9a-f]{2}){32,256}$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDevice(value: unknown): Device | null {
  if (!isRecord(value)) return null;
  const { token, environment, kind } = value;
  if (typeof token !== "string" || !HEX_TOKEN.test(token)) return null;
  if (environment !== "production" && environment !== "development") return null;
  if (kind !== "alert" && kind !== "liveactivity") return null;
  return { token: token.toLowerCase(), environment, kind };
}

/** `secret` is base64 of 32 bytes; anything else counts as unconfigured. */
export async function importHandleKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (!secret) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(secret.trim());
  } catch {
    return null;
  }
  if (raw.byteLength !== 32) return null;
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealHandle(key: CryptoKey, device: Device): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = utf8(JSON.stringify({ token: device.token, environment: device.environment, kind: device.kind }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const sealed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(ciphertext, IV_BYTES);
  return bytesToBase64Url(sealed);
}

/** Returns null for handles that fail to decode, authenticate, or parse. */
export async function openHandle(key: CryptoKey, handle: string): Promise<Device | null> {
  try {
    const sealed = base64ToBytes(handle);
    if (sealed.byteLength <= IV_BYTES) return null;
    const iv = sealed.subarray(0, IV_BYTES);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed.subarray(IV_BYTES));
    return parseDevice(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    return null;
  }
}
