import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hostIdFor, verifyHostAuth } from "../src/auth.js";
import { ByteBudget } from "../src/budget.js";
import type { Env, RateLimiter } from "../src/cloudflare.js";
import worker from "../src/index.js";
import { LIMITS } from "../src/protocol.js";
import { rateLimitKey } from "../src/ratelimit.js";
import { hostKeys, START } from "./support.js";

const HOST_ID = "abcdefghijklmnopqrstuv";
const MiB = 1024 * 1024;

function upgrade(path: string, ip = "203.0.113.7"): Request {
  return new Request(`https://relay.test${path}`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } });
}

function env(overrides: Partial<Env> = {}) {
  const names: string[] = [];
  const stubFetch = vi.fn(async (_request: Request) => new Response("forwarded"));
  const value: Env = {
    HOSTS: {
      idFromName: (name) => {
        names.push(name);
        return { name };
      },
      get: () => ({ fetch: stubFetch }),
    },
    ...overrides,
  };
  return { env: value, names, stubFetch };
}

function limiter(success: boolean) {
  return { limit: vi.fn<RateLimiter["limit"]>(async () => ({ success })) };
}

describe("worker", () => {
  it("answers /health", async () => {
    const response = await worker.fetch(new Request("https://relay.test/health"), env().env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, protocol: 1 });
  });

  it("returns 404 for other paths, 426 without an upgrade, and 400 for a bad id", async () => {
    expect((await worker.fetch(new Request("https://relay.test/v1/other"), env().env)).status).toBe(404);
    for (const path of ["/v1/host", "/v1/connect"]) {
      const plain = await worker.fetch(new Request(`https://relay.test${path}?id=${HOST_ID}`), env().env);
      expect(plain.status).toBe(426);
      expect(plain.headers.get("Upgrade")).toBe("websocket");
      for (const query of ["", "?id=short", `?id=${HOST_ID}a`, `?id=${HOST_ID.slice(1)}+`]) {
        expect((await worker.fetch(upgrade(`${path}${query}`), env().env)).status).toBe(400);
      }
    }
  });

  it("forwards sockets to the Durable Object named after the host id", async () => {
    const { env: value, names, stubFetch } = env();
    const response = await worker.fetch(upgrade(`/v1/connect?id=${HOST_ID}`), value);
    expect(await response.text()).toBe("forwarded");
    expect(names).toEqual([`host:${HOST_ID}`]);
    expect(stubFetch).toHaveBeenCalledOnce();
  });

  it("returns 429 before the upgrade when the per-IP limiter refuses", async () => {
    const hostLimiter = limiter(false);
    const connectLimiter = limiter(true);
    const { env: value, stubFetch } = env({ HOST_LIMITER: hostLimiter, CONNECT_LIMITER: connectLimiter });
    const refused = await worker.fetch(upgrade(`/v1/host?id=${HOST_ID}`, "2001:db8:1:2:3:4:5:6"), value);
    expect(refused.status).toBe(429);
    expect(hostLimiter.limit).toHaveBeenCalledWith({ key: "2001:db8:1:2::/64" });
    expect(stubFetch).not.toHaveBeenCalled();
    const allowed = await worker.fetch(upgrade(`/v1/connect?id=${HOST_ID}`), value);
    expect(allowed.status).toBe(200);
    expect(connectLimiter.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
  });
});

describe("rate-limit keys", () => {
  it.each([
    ["198.51.100.4", "198.51.100.4"],
    ["2001:0DB8:0001:0002:0003:0004:0005:0006", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::7", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%en0", "fe80:0:0:0::/64"],
    ["2001:db8:1:2:3:4:192.0.2.1", "2001:db8:1:2::/64"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["not:an:address", "not:an:address"],
    [null, "unknown"],
  ])("%s -> %s", (ip, key) => {
    expect(rateLimitKey(ip)).toBe(key);
  });
});

describe("host auth", () => {
  it("derives the host id from SHA-256 of the raw Ed25519 key", async () => {
    const keys = await hostKeys();
    const expected = createHash("sha256").update(keys.raw).digest("base64url").slice(0, 22);
    expect(await hostIdFor(Uint8Array.from(keys.raw))).toBe(expected);
    expect(keys.id).toBe(expected);
  });

  it("verifies only a signature over oxbit-relay-v1:<hostId>:<nonce>", async () => {
    const keys = await hostKeys();
    const sig = await keys.sign(keys.id, "nonce");
    expect(await verifyHostAuth(keys.id, "nonce", keys.key, sig)).toBe(true);
    expect(await verifyHostAuth(keys.id, "other", keys.key, sig)).toBe(false);
    const tampered = Buffer.from(sig, "base64url");
    tampered[0] ^= 1;
    expect(await verifyHostAuth(keys.id, "nonce", keys.key, tampered.toString("base64url"))).toBe(false);
    expect(await verifyHostAuth(keys.id, "nonce", `${keys.key}AA`, sig)).toBe(false);
    expect(await verifyHostAuth(keys.id, "nonce", `${keys.key}=`, sig)).toBe(false);
  });
});

describe("byte budget", () => {
  it("allows 64 MiB per minute and 2 GiB per UTC day", () => {
    const save = vi.fn();
    const budget = new ByteBudget(LIMITS, undefined, save);
    expect(budget.take(64 * MiB, START)).toBe(true);
    expect(budget.take(1, START + 59_999)).toBe(false);
    for (let minute = 1; minute < 32; minute += 1) expect(budget.take(64 * MiB, START + minute * 60_000)).toBe(true);
    expect(budget.exhausted(START + 32 * 60_000)).toBe(true);
    expect(budget.take(1, START + 33 * 60_000)).toBe(false);
    expect(save).toHaveBeenCalledTimes(32);
    expect(save).toHaveBeenLastCalledWith({ day: "2026-10-19", bytes: 2048 * MiB });
    expect(budget.take(64 * MiB, Date.UTC(2026, 9, 20))).toBe(true);
  });
});
