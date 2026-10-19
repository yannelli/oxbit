export const PROTOCOL_VERSION = 1;
export const HOST_PATH = "/v1/host";
export const CONNECT_PATH = "/v1/connect";
export const HOST_ID = /^[A-Za-z0-9_-]{22}$/;
export const CONNECTION_ID = /^[A-Za-z0-9_-]{22}$/;
export const CONNECTION_ID_BYTES = 16;
export const NONCE_BYTES = 32;
export const SIGNING_PREFIX = "oxbit-relay-v1";

export const CLOSE = {
  unauthenticated: 4401,
  dropped: 4403,
  hostOffline: 4404,
  timeout: 4408,
  replaced: 4409,
  tooLarge: 4413,
  limited: 4429,
} as const;

const MiB = 1024 * 1024;

export interface Limits {
  authMs: number;
  handshakeMs: number;
  idleMs: number;
  established: number;
  handshaking: number;
  frameBytes: number;
  minuteBytes: number;
  dayBytes: number;
  /** Unsaved daily bytes that trigger a storage write. */
  dayFlushBytes: number;
}

export const LIMITS: Limits = {
  authMs: 10_000,
  handshakeMs: 10_000,
  idleMs: 10 * 60_000,
  established: 8,
  handshaking: 4,
  frameBytes: MiB,
  minuteBytes: 64 * MiB,
  dayBytes: 2 * 1024 * MiB,
  dayFlushBytes: 16 * MiB,
};

export type HostMessage =
  | { t: "auth"; key: string; sig: string }
  | { t: "established"; c: string }
  | { t: "close"; c: string; reason: string };

export type RelayMessage =
  | { t: "challenge"; nonce: string }
  | { t: "ready" }
  | { t: "open"; c: string }
  | { t: "closed"; c: string };

export function parseHostMessage(text: string): HostMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.t === "auth") {
    const { key, sig } = message;
    return typeof key === "string" && typeof sig === "string" ? { t: "auth", key, sig } : null;
  }
  if (typeof message.c !== "string" || !CONNECTION_ID.test(message.c)) return null;
  if (message.t === "established") return { t: "established", c: message.c };
  if (message.t === "close") {
    const reason = typeof message.reason === "string" ? message.reason : "";
    return { t: "close", c: message.c, reason };
  }
  return null;
}

export function encode(message: RelayMessage): string {
  return JSON.stringify(message);
}

export function prefixFrame(id: Uint8Array, payload: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(CONNECTION_ID_BYTES + payload.byteLength);
  frame.set(id);
  frame.set(new Uint8Array(payload), CONNECTION_ID_BYTES);
  return frame;
}

export function splitFrame(frame: ArrayBuffer): { id: string; payload: ArrayBuffer } | null {
  if (frame.byteLength < CONNECTION_ID_BYTES) return null;
  return {
    id: bytesToBase64Url(new Uint8Array(frame, 0, CONNECTION_ID_BYTES)),
    payload: frame.slice(CONNECTION_ID_BYTES),
  };
}

/** WebSocket close reasons are capped at 123 bytes of UTF-8. */
export function closeReason(text: string): string {
  const chars = Array.from(text).slice(0, 123);
  while (utf8(chars.join("")).byteLength > 123) chars.pop();
  return chars.join("");
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Returns null for anything other than unpadded base64url. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}
