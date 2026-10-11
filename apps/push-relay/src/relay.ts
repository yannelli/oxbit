import type { PushActivityState, PushDeviceResponse, PushRequest, PushResponse } from "@oxbit/sdk";
import { apnsRequest, providerToken, readApnsResponse, type ApnsCredentials, type Notification } from "./apns.js";
import { importHandleKey, isRecord, openHandle, parseDevice, sealHandle } from "./handle.js";

export interface Env {
  BUNDLE_ID?: string;
  HANDLE_SECRET?: string;
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
}

export interface Deps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Milliseconds since the Unix epoch. */
  now: () => number;
}

const DEFAULT_BUNDLE_ID = "com.yannelli.oxbit";
const MAX_BODY_BYTES = 4096;
const STATUSES = new Set<string>(["working", "waiting", "finished", "failed"]);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const defaultDeps: Deps = { fetch: (url, init) => fetch(url, init), now: () => Date.now() };

export async function handleRequest(request: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/devices") return registerDevice(request, env);
  if (pathname === "/v1/push") return push(request, env, deps);
  return json({ error: "NotFound" }, 404);
}

async function registerDevice(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json({ error: "MethodNotAllowed" }, 405, { ...CORS, Allow: "POST, OPTIONS" });
  const key = await importHandleKey(env.HANDLE_SECRET);
  if (!key) return json({ error: "RelayNotConfigured" }, 503, CORS);
  const body = await readBody(request);
  if ("reason" in body) return json({ error: body.reason }, body.status, CORS);
  const device = parseDevice(body.value);
  if (!device) return json({ error: "BadDevice" }, 400, CORS);
  const response: PushDeviceResponse = { handle: await sealHandle(key, device) };
  return json(response, 200, CORS);
}

async function push(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (request.method !== "POST") return reply({ sent: false, reason: "MethodNotAllowed" }, 405, { Allow: "POST" });
  const key = await importHandleKey(env.HANDLE_SECRET);
  const credentials = apnsCredentials(env);
  if (!key || !credentials) return reply({ sent: false, reason: "RelayNotConfigured" }, 503);
  const body = await readBody(request);
  if ("reason" in body) return reply({ sent: false, reason: body.reason }, body.status);
  const value = isRecord(body.value) ? body.value : {};
  const device = typeof value.handle === "string" ? await openHandle(key, value.handle) : null;
  if (!device) return reply({ sent: false, reason: "BadHandle" }, 400);
  const notification = parseNotification(value);
  if (!notification) return reply({ sent: false, reason: "BadPayload" }, 400);
  if (notification.kind !== device.kind) return reply({ sent: false, reason: "KindMismatch" }, 400);

  const now = Math.floor(deps.now() / 1000);
  let token: string;
  try {
    token = await providerToken(credentials, now);
  } catch {
    return reply({ sent: false, reason: "BadProviderKey" }, 503);
  }
  let response: Response;
  try {
    response = await deps.fetch(...apnsRequest(device, notification, env.BUNDLE_ID || DEFAULT_BUNDLE_ID, token, now));
  } catch {
    return reply({ sent: false, reason: "ApnsUnreachable" }, 502);
  }
  const result = await readApnsResponse(response);
  return reply(result.body, result.status);
}

function apnsCredentials(env: Env): ApnsCredentials | null {
  const { APNS_KEY: key, APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId } = env;
  return key && keyId && teamId ? { key, keyId, teamId } : null;
}

function parseNotification(value: Record<string, unknown>): Notification | null {
  const { alert, activity } = value;
  if ((alert === undefined) === (activity === undefined)) return null;
  if (alert !== undefined) {
    if (!isRecord(alert) || typeof alert.title !== "string" || typeof alert.body !== "string") return null;
    return { kind: "alert", alert: { title: alert.title, body: alert.body } };
  }
  const parsed = parseActivity(activity);
  return parsed && { kind: "liveactivity", activity: parsed };
}

function parseActivity(value: unknown): NonNullable<PushRequest["activity"]> | null {
  if (!isRecord(value) || !isRecord(value.state)) return null;
  const { event, state, staleDate, dismissalDate } = value;
  if (event !== "update" && event !== "end") return null;
  if (!isOptionalNumber(staleDate) || !isOptionalNumber(dismissalDate)) return null;
  if (dismissalDate !== undefined && event !== "end") return null;
  const { status, title, detail, pending, startedAt } = state;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  if (typeof title !== "string" || typeof detail !== "string") return null;
  if (!isNumber(pending) || !isOptionalNumber(startedAt)) return null;
  const content: PushActivityState = { status: status as PushActivityState["status"], title, detail, pending, startedAt };
  return { event, state: content, staleDate, dismissalDate };
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isNumber(value);
}

async function readBody(request: Request): Promise<{ value: unknown } | { status: 400 | 413; reason: string }> {
  const tooLarge = { status: 413 as const, reason: "PayloadTooLarge" };
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return tooLarge;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return tooLarge;
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { status: 400, reason: "BadJson" };
  }
}

function reply(body: PushResponse, status: number, headers: Record<string, string> = {}): Response {
  return json(body, status, headers);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
