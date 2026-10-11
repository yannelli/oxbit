import type { PushDeviceRequest, PushRequest } from "@oxbit/sdk";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { handleRequest, type Deps, type Env } from "../src/relay.js";
import { ACTIVITY_TOKEN, ALERT_TOKEN, decodeSegment, relayEnv } from "./support.js";

const NOW_MS = 1_800_000_000_500;
const NOW = 1_800_000_000;
const HOSTS = { production: "https://api.push.apple.com", development: "https://api.sandbox.push.apple.com" };

function post(path: string, body: unknown): Request {
  return new Request(`https://relay.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function apns(status = 200, body?: object) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(body ? JSON.stringify(body) : null, { status }));
}

function deps(fetch: Deps["fetch"], now = NOW_MS): Deps {
  return { fetch, now: () => now };
}

async function register(env: Env, device: PushDeviceRequest): Promise<string> {
  const response = await handleRequest(post("/v1/devices", device), env);
  expect(response.status).toBe(200);
  return ((await response.json()) as { handle: string }).handle;
}

function sent(fetch: ReturnType<typeof apns>, call = 0) {
  const [url, init] = fetch.mock.calls[call];
  return { url, headers: init.headers as Record<string, string>, payload: JSON.parse(init.body as string) };
}

const state = { status: "waiting" as const, title: "Fix build", detail: "Approve edit", pending: 1, startedAt: NOW - 60 };

describe("POST /v1/push", () => {
  it.each(["production", "development"] as const)("sends an alert to the %s host", async (environment) => {
    const env = await relayEnv();
    const handle = await register(env, { token: ALERT_TOKEN.toUpperCase(), environment, kind: "alert" });
    const fetch = apns();
    const alert = { title: "Agent needs your input", body: "Fix build" };
    const response = await handleRequest(post("/v1/push", { handle, alert } satisfies PushRequest), env, deps(fetch));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    const { url, headers, payload } = sent(fetch);
    expect(url).toBe(`${HOSTS[environment]}/3/device/${ALERT_TOKEN}`);
    expect(headers).toEqual({
      authorization: expect.stringMatching(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/),
      "apns-topic": "com.yannelli.oxbit",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": "oxbit-agent-acp",
    });
    expect(payload).toEqual({ aps: { alert, sound: "default", "thread-id": "oxbit-agent-acp" } });
  });

  it.each(["production", "development"] as const)("sends a Live Activity update to the %s host", async (environment) => {
    const env = await relayEnv();
    const handle = await register(env, { token: ACTIVITY_TOKEN, environment, kind: "liveactivity" });
    const fetch = apns();
    const activity = { event: "update" as const, state, staleDate: NOW + 900 };
    const response = await handleRequest(post("/v1/push", { handle, activity }), env, deps(fetch));
    expect(await response.json()).toEqual({ sent: true });
    const { url, headers, payload } = sent(fetch);
    expect(url).toBe(`${HOSTS[environment]}/3/device/${ACTIVITY_TOKEN}`);
    expect(headers).toEqual({
      authorization: expect.stringMatching(/^bearer /),
      "apns-topic": "com.yannelli.oxbit.push-type.liveactivity",
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
    });
    expect(payload).toEqual({ aps: { timestamp: NOW, event: "update", "content-state": state, "stale-date": NOW + 900 } });
  });

  it("accepts a 128-byte Live Activity token with a handle the runtime stores", async () => {
    const env = await relayEnv();
    const token = "ef".repeat(128);
    const handle = await register(env, { token, environment: "development", kind: "liveactivity" });
    expect(handle.length).toBeLessThanOrEqual(1024);
    const fetch = apns();
    const response = await handleRequest(post("/v1/push", { handle, activity: { event: "update", state } }), env, deps(fetch));
    expect(await response.json()).toEqual({ sent: true });
    expect(sent(fetch).url).toBe(`${HOSTS.development}/3/device/${token}`);
    const longest = await register(env, { token: "ef".repeat(256), environment: "production", kind: "liveactivity" });
    expect(longest.length).toBeLessThanOrEqual(1024);
  });

  it("sends a Live Activity end with a dismissal date", async () => {
    const env = await relayEnv();
    const handle = await register(env, { token: ACTIVITY_TOKEN, environment: "production", kind: "liveactivity" });
    const fetch = apns();
    const ended = { ...state, status: "finished" as const, pending: 0 };
    const activity = { event: "end" as const, state: ended, dismissalDate: NOW + 900 };
    await handleRequest(post("/v1/push", { handle, activity }), env, deps(fetch));
    expect(sent(fetch).payload).toEqual({
      aps: { timestamp: NOW, event: "end", "content-state": ended, "dismissal-date": NOW + 900 },
    });
  });

  it.each([
    [410, { reason: "Unregistered" }, 200, { sent: false, gone: true, reason: "Unregistered" }],
    [410, undefined, 200, { sent: false, gone: true, reason: "ApnsStatus410" }],
    [400, { reason: "BadDeviceToken" }, 200, { sent: false, gone: true, reason: "BadDeviceToken" }],
    [400, { reason: "Unregistered" }, 200, { sent: false, gone: true, reason: "Unregistered" }],
    [400, { reason: "BadTopic" }, 502, { sent: false, reason: "BadTopic" }],
    [429, { reason: "TooManyRequests" }, 502, { sent: false, reason: "TooManyRequests" }],
    [500, undefined, 502, { sent: false, reason: "ApnsStatus500" }],
  ])("maps APNs %i %j", async (apnsStatus, apnsBody, status, body) => {
    const env = await relayEnv();
    const handle = await register(env, { token: ALERT_TOKEN, environment: "production", kind: "alert" });
    const response = await handleRequest(
      post("/v1/push", { handle, alert: { title: "Agent finished", body: "Fix build" } }),
      env,
      deps(apns(apnsStatus, apnsBody)),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it("reports an unreachable APNs as 502", async () => {
    const env = await relayEnv();
    const handle = await register(env, { token: ALERT_TOKEN, environment: "production", kind: "alert" });
    const fetch = vi.fn(async () => Promise.reject(new TypeError("network")));
    const response = await handleRequest(post("/v1/push", { handle, alert: { title: "t", body: "b" } }), env, deps(fetch));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ sent: false, reason: "ApnsUnreachable" });
  });

  it("reuses the provider token for 50 minutes", async () => {
    const env = await relayEnv();
    const handle = await register(env, { token: ALERT_TOKEN, environment: "production", kind: "alert" });
    const fetch = apns();
    for (const offset of [0, 60, 49 * 60, 50 * 60, 51 * 60]) {
      await handleRequest(post("/v1/push", { handle, alert: { title: "t", body: "b" } }), env, deps(fetch, NOW_MS + offset * 1000));
    }
    const tokens = fetch.mock.calls.map((_, call) => sent(fetch, call).headers.authorization.slice("bearer ".length));
    expect(new Set(tokens.slice(0, 3)).size).toBe(1);
    expect(tokens[3]).not.toBe(tokens[0]);
    expect(tokens[4]).toBe(tokens[3]);
    expect(decodeSegment(tokens[0].split(".")[1])).toMatchObject({ iat: NOW });
    expect(decodeSegment(tokens[3].split(".")[1])).toMatchObject({ iat: NOW + 50 * 60 });
  });

  it("rejects a handle whose kind does not match the payload", async () => {
    const env = await relayEnv();
    const handle = await register(env, { token: ACTIVITY_TOKEN, environment: "production", kind: "liveactivity" });
    const fetch = apns();
    const response = await handleRequest(post("/v1/push", { handle, alert: { title: "t", body: "b" } }), env, deps(fetch));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ sent: false, reason: "KindMismatch" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects bad handles and payloads", async () => {
    const env = await relayEnv();
    const handle = await register(env, { token: ALERT_TOKEN, environment: "production", kind: "alert" });
    const activity = { event: "update", state };
    const cases: [unknown, string][] = [
      [{ handle: "AAAA", alert: { title: "t", body: "b" } }, "BadHandle"],
      [{ alert: { title: "t", body: "b" } }, "BadHandle"],
      [{ handle }, "BadPayload"],
      [{ handle, alert: { title: "t", body: "b" }, activity }, "BadPayload"],
      [{ handle, alert: { title: "t" } }, "BadPayload"],
      [{ handle, activity: { ...activity, state: { ...state, status: "paused" } } }, "BadPayload"],
      [{ handle, activity: { ...activity, dismissalDate: NOW } }, "BadPayload"],
      ["{", "BadJson"],
    ];
    const fetch = apns();
    for (const [body, reason] of cases) {
      const response = await handleRequest(post("/v1/push", body), env, deps(fetch));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ sent: false, reason });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["APNS_KEY", "APNS_KEY_ID", "APNS_TEAM_ID", "HANDLE_SECRET"] as const)("returns 503 without %s", async (name) => {
    const env = await relayEnv();
    const handle = await register(env, { token: ALERT_TOKEN, environment: "production", kind: "alert" });
    const fetch = apns();
    const response = await handleRequest(
      post("/v1/push", { handle, alert: { title: "t", body: "b" } }),
      { ...env, [name]: undefined },
      deps(fetch),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ sent: false, reason: "RelayNotConfigured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects bodies over 4 KB", async () => {
    const env = await relayEnv();
    const response = await handleRequest(post("/v1/push", { handle: "x".repeat(4096) }), env, deps(apns()));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ sent: false, reason: "PayloadTooLarge" });
  });
});

describe("POST /v1/devices", () => {
  it("answers CORS preflight and adds CORS headers to responses", async () => {
    const preflight = await worker.fetch(
      new Request("https://relay.test/v1/devices", {
        method: "OPTIONS",
        headers: { Origin: "tauri://localhost", "Access-Control-Request-Method": "POST" },
      }),
      {},
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    const env = await relayEnv();
    const created = await handleRequest(post("/v1/devices", { token: ALERT_TOKEN, environment: "production", kind: "alert" }), env);
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const rejected = await handleRequest(post("/v1/devices", {}), env);
    expect(rejected.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("validates the token, environment and kind", async () => {
    const env = await relayEnv();
    const valid = { token: ALERT_TOKEN, environment: "production", kind: "alert" };
    const invalid = [
      { ...valid, token: `${ALERT_TOKEN}a` },
      { ...valid, token: "ab".repeat(31) },
      { ...valid, token: "ab".repeat(257) },
      { ...valid, token: "zz".repeat(32) },
      { ...valid, environment: "staging" },
      { ...valid, kind: "voip" },
    ];
    for (const body of invalid) {
      const response = await handleRequest(post("/v1/devices", body), env);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "BadDevice" });
    }
    expect((await handleRequest(post("/v1/devices", { ...valid, token: "ab".repeat(100) }), env)).status).toBe(200);
  });

  it("returns 503 without HANDLE_SECRET and 413 over 4 KB", async () => {
    const device = { token: ALERT_TOKEN, environment: "production", kind: "alert" };
    const missing = await handleRequest(post("/v1/devices", device), await relayEnv({ HANDLE_SECRET: undefined }));
    expect(missing.status).toBe(503);
    expect(missing.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const large = await handleRequest(post("/v1/devices", { ...device, pad: "x".repeat(4096) }), await relayEnv());
    expect(large.status).toBe(413);
  });
});

it("returns 404 for other paths", async () => {
  const response = await worker.fetch(new Request("https://relay.test/v1/other", { method: "POST" }), {});
  expect(response.status).toBe(404);
});
