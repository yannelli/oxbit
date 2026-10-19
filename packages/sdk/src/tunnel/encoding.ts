const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Fresh bytes backed by an `ArrayBuffer`, as WebCrypto parameters require. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** RFC 4648 section 5 base64url without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += ALPHABET[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

/** Throws on characters outside the base64url alphabet, padding, or an impossible length. */
export function base64urlDecode(text: string): Bytes {
  if (text.length % 4 === 1) throw new Error("Invalid base64url length");
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    const digit = LOOKUP.get(char);
    if (digit === undefined) throw new Error("Invalid base64url character");
    value = ((value << 6) | digit) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  if (value & ((1 << bits) - 1)) throw new Error("Invalid base64url trailing bits");
  return out;
}

export const base64url = { encode: base64urlEncode, decode: base64urlDecode };

export function utf8Encode(text: string): Bytes {
  return encoder.encode(text) as Bytes;
}

/** Throws on invalid UTF-8. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function hexDecode(hex: string): Bytes {
  if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error("Invalid hex");
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}
