import type { Env } from "../src/relay.js";

export const HANDLE_SECRET = Buffer.alloc(32, 7).toString("base64");
export const ALERT_TOKEN = "ab".repeat(32);
export const ACTIVITY_TOKEN = "cd".repeat(40);

export async function apnsKeyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const lines = der.match(/.{1,64}/g)!.join("\n");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

export async function relayEnv(overrides: Env = {}): Promise<Env> {
  const { pem } = await apnsKeyPair();
  return {
    BUNDLE_ID: "com.yannelli.oxbit",
    HANDLE_SECRET,
    APNS_KEY: pem,
    APNS_KEY_ID: "KEY1234567",
    APNS_TEAM_ID: "TEAM123456",
    ...overrides,
  };
}

export function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}
