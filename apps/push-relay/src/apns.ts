import type { PushRequest, PushResponse } from "@oxbit/sdk";
import { base64ToBytes, bytesToBase64Url, utf8 } from "./base64.js";
import type { Device } from "./handle.js";

/** Matches `PUSH_COLLAPSE_ID` in @oxbit/sdk; tests pin the two together. */
export const COLLAPSE_ID = "oxbit-agent-acp";
/** APNs rejects provider tokens older than an hour and throttles regeneration. */
export const PROVIDER_TOKEN_MAX_AGE_SECONDS = 50 * 60;

const HOSTS: Record<Device["environment"], string> = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
};
const GONE_REASONS = new Set(["BadDeviceToken", "Unregistered"]);

export interface ApnsCredentials {
  key: string;
  keyId: string;
  teamId: string;
}

export type Notification =
  | { kind: "alert"; alert: NonNullable<PushRequest["alert"]> }
  | { kind: "liveactivity"; activity: NonNullable<PushRequest["activity"]> };

let cachedToken: { id: string; issuedAt: number; token: Promise<string> } | undefined;

/** `now` is Unix seconds. Concurrent callers share one signing. */
export function providerToken(credentials: ApnsCredentials, now: number): Promise<string> {
  const id = `${credentials.teamId}\n${credentials.keyId}\n${credentials.key}`;
  if (cachedToken?.id === id && now - cachedToken.issuedAt < PROVIDER_TOKEN_MAX_AGE_SECONDS) return cachedToken.token;
  const entry = { id, issuedAt: now, token: signProviderToken(credentials, now) };
  cachedToken = entry;
  entry.token.catch(() => {
    if (cachedToken === entry) cachedToken = undefined;
  });
  return entry.token;
}

async function signProviderToken({ key, keyId, teamId }: ApnsCredentials, issuedAt: number): Promise<string> {
  const der = base64ToBytes(key.replace(/-----(?:BEGIN|END) PRIVATE KEY-----|\\n|\s/g, ""));
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const unsigned = `${jsonSegment({ alg: "ES256", kid: keyId })}.${jsonSegment({ iss: teamId, iat: issuedAt })}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, utf8(unsigned));
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function jsonSegment(value: object): string {
  return bytesToBase64Url(utf8(JSON.stringify(value)));
}

export function apnsRequest(
  device: Device,
  notification: Notification,
  bundleId: string,
  token: string,
  now: number,
): [url: string, init: RequestInit] {
  const headers: Record<string, string> = { authorization: `bearer ${token}`, "apns-priority": "10" };
  let payload: object;
  if (notification.kind === "alert") {
    headers["apns-topic"] = bundleId;
    headers["apns-push-type"] = "alert";
    headers["apns-collapse-id"] = COLLAPSE_ID;
    payload = { aps: { alert: notification.alert, sound: "default", "thread-id": COLLAPSE_ID } };
  } else {
    const { event, state, staleDate, dismissalDate } = notification.activity;
    headers["apns-topic"] = `${bundleId}.push-type.liveactivity`;
    headers["apns-push-type"] = "liveactivity";
    payload = {
      aps: { timestamp: now, event, "content-state": state, "stale-date": staleDate, "dismissal-date": dismissalDate },
    };
  }
  const url = `${HOSTS[device.environment]}/3/device/${device.token}`;
  return [url, { method: "POST", headers, body: JSON.stringify(payload) }];
}

export async function readApnsResponse(response: Response): Promise<{ status: number; body: PushResponse }> {
  if (response.ok) return { status: 200, body: { sent: true } };
  const json: unknown = await response.json().catch(() => undefined);
  const reason =
    typeof json === "object" && json !== null && "reason" in json && typeof json.reason === "string"
      ? json.reason
      : `ApnsStatus${response.status}`;
  if (response.status === 410 || (response.status === 400 && GONE_REASONS.has(reason))) {
    return { status: 200, body: { sent: false, gone: true, reason } };
  }
  return { status: 502, body: { sent: false, reason } };
}
