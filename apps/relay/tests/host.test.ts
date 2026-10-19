import { describe, expect, it } from "vitest";
import { Harness, hostKeys, START } from "./support.js";

describe("host admission", () => {
  it("sends a challenge, verifies the signed nonce, and answers ready", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.open("/v1/host");
    const challenge = host.messages()[0] as { t: string; nonce: string };
    expect(challenge.t).toBe("challenge");
    expect(Buffer.from(challenge.nonce, "base64url")).toHaveLength(32);
    expect(host.tags).toEqual(["host"]);
    expect(harness.state.alarm).toBe(START + 10_000);
    expect(harness.state.autoResponse).toEqual({ request: "ping", response: "pong" });
    const sig = await harness.keys.sign(harness.keys.id, challenge.nonce);
    await harness.text(host, { t: "auth", key: harness.keys.key, sig });
    expect(host.messages()[1]).toEqual({ t: "ready" });
    expect(host.closed).toBeNull();
    await harness.advance(10_000);
    expect(host.closed).toBeNull();
  });

  it("closes with 4401 for a key that does not hash to the id", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host(await hostKeys());
    expect(host.closed).toEqual({ code: 4401, reason: "auth failed" });
    expect(host.messages()).toHaveLength(1);
  });

  it("closes with 4401 for a signature over another nonce or a malformed auth", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.open("/v1/host");
    await harness.text(host, { t: "auth", key: harness.keys.key, sig: await harness.keys.sign(harness.keys.id, "other") });
    expect(host.closed).toEqual({ code: 4401, reason: "auth failed" });
    for (const message of ["{", { t: "auth", key: harness.keys.key }, { t: "auth", key: "AA", sig: "AA" }]) {
      const socket = await harness.open("/v1/host");
      await harness.text(socket, message);
      expect(socket.closed?.code).toBe(4401);
    }
    const binary = await harness.open("/v1/host");
    await harness.binary(binary, new Uint8Array(20));
    expect(binary.closed).toEqual({ code: 4401, reason: "not authenticated" });
  });

  it("closes with 4401 after 10 seconds without auth, including a late auth", async () => {
    const harness = new Harness(await hostKeys());
    const idle = await harness.open("/v1/host");
    await harness.advance(9_999);
    expect(idle.closed).toBeNull();
    await harness.advance(1);
    expect(idle.closed).toEqual({ code: 4401, reason: "auth timeout" });
    const late = await harness.open("/v1/host");
    const { nonce } = late.messages()[0] as { nonce: string };
    harness.now += 10_000;
    await harness.text(late, { t: "auth", key: harness.keys.key, sig: await harness.keys.sign(harness.keys.id, nonce) });
    expect(late.closed).toEqual({ code: 4401, reason: "auth timeout" });
  });

  it("replaces an authenticated host with 4409 and closes its devices with 4404", async () => {
    const harness = new Harness(await hostKeys());
    const first = await harness.host();
    const { socket: device } = await harness.establish(first);
    const second = await harness.host();
    expect(first.closed).toEqual({ code: 4409, reason: "replaced" });
    expect(device.closed).toEqual({ code: 4404, reason: "host offline" });
    expect(second.messages().at(-1)).toEqual({ t: "ready" });
    const { socket: next } = await harness.device(second);
    await harness.peerClose(first);
    await harness.peerClose(device);
    expect(next.closed).toBeNull();
    expect(second.messages().filter((message) => (message as { t: string }).t === "closed")).toEqual([]);
  });

  it("closes devices with 4404 when the host socket closes", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host();
    const { socket: device } = await harness.establish(host);
    await harness.peerClose(host);
    expect(device.closed).toEqual({ code: 4404, reason: "host offline" });
    const late = await harness.open("/v1/connect");
    expect(late.closed?.code).toBe(4404);
  });
});

describe("device sockets", () => {
  it("accepts and closes with 4404 when no host has authenticated", async () => {
    const harness = new Harness(await hostKeys());
    const offline = await harness.open("/v1/connect");
    expect(offline.accepted).toBe(true);
    expect(offline.closed).toEqual({ code: 4404, reason: "host offline" });
    const pending = await harness.open("/v1/host");
    const stillOffline = await harness.open("/v1/connect");
    expect(stillOffline.closed?.code).toBe(4404);
    expect(pending.messages()).toHaveLength(1);
  });

  it("opens, forwards with the connection id prefix, and reports closes", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host();
    const { socket: device, c } = await harness.device(host);
    expect(c).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(c, "base64url")).toHaveLength(16);
    expect(device.tags).toEqual(["device", `c:${c}`]);
    await harness.binary(device, Uint8Array.from([1, 2, 3]));
    expect(host.binaries()).toEqual([Uint8Array.from([...Buffer.from(c, "base64url"), 1, 2, 3])]);
    await harness.binary(host, Uint8Array.from([...Buffer.from(c, "base64url"), 4, 5]));
    expect(device.binaries()).toEqual([Uint8Array.from([4, 5])]);
    await harness.binary(host, Uint8Array.from([...Buffer.alloc(16, 9), 6]));
    await harness.binary(host, Uint8Array.from([1, 2]));
    await harness.text(device, "hello");
    expect(device.binaries()).toHaveLength(1);
    expect(host.binaries()).toHaveLength(1);
    await harness.peerClose(device);
    expect(host.messages().at(-1)).toEqual({ t: "closed", c });
  });

  it("closes a device with 4403 and the host's reason, then reports closed once", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host();
    const { socket: device, c } = await harness.establish(host);
    await harness.text(host, { t: "close", c, reason: "revoked" });
    expect(device.closed).toEqual({ code: 4403, reason: "revoked" });
    await harness.peerClose(device);
    const { socket: other, c: otherId } = await harness.device(host);
    await harness.text(host, { t: "close", c: otherId, reason: "é".repeat(100) });
    expect(Buffer.byteLength(other.closed!.reason)).toBe(122);
    expect(host.messages().filter((message) => (message as { t: string }).t === "closed")).toEqual([
      { t: "closed", c },
      { t: "closed", c: otherId },
    ]);
  });

  it("refuses a fifth device in the handshake with 4429", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host();
    for (let index = 0; index < 4; index += 1) await harness.device(host);
    const extra = await harness.open("/v1/connect");
    expect(extra.closed).toEqual({ code: 4429, reason: "too many handshakes" });
    expect(host.messages().filter((message) => (message as { t: string }).t === "open")).toHaveLength(4);
  });

  it("caps established devices at 8 at connect time and at the established message", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host();
    for (let index = 0; index < 7; index += 1) await harness.establish(host);
    const a = await harness.device(host);
    const b = await harness.device(host);
    await harness.text(host, { t: "established", c: a.c });
    await harness.text(host, { t: "established", c: b.c });
    expect(a.socket.closed).toBeNull();
    expect(b.socket.closed).toEqual({ code: 4429, reason: "too many devices" });
    expect(host.messages().at(-1)).toEqual({ t: "closed", c: b.c });
    const ninth = await harness.open("/v1/connect");
    expect(ninth.closed).toEqual({ code: 4429, reason: "too many devices" });
  });
});

describe("deadlines", () => {
  it("closes a device that has not finished the handshake in 10 seconds with 4408", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host();
    const { socket: device, c } = await harness.device(host);
    await harness.advance(9_999);
    expect(device.closed).toBeNull();
    await harness.advance(1);
    expect(device.closed).toEqual({ code: 4408, reason: "handshake timeout" });
    expect(host.messages().at(-1)).toEqual({ t: "closed", c });
  });

  it("closes an established device after 10 minutes without binary traffic, across hibernation", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host();
    const { socket: device, c } = await harness.establish(host);
    await harness.advance(5 * 60_000);
    await harness.binary(device, Uint8Array.from([1]));
    harness.wake();
    await harness.ready();
    await harness.advance(10 * 60_000 - 1);
    expect(device.closed).toBeNull();
    await harness.binary(host, Uint8Array.from([...Buffer.from(c, "base64url"), 2]));
    harness.wake();
    await harness.advance(10 * 60_000 - 1);
    expect(device.closed).toBeNull();
    await harness.advance(1);
    expect(device.closed).toEqual({ code: 4408, reason: "idle" });
    expect(host.messages().at(-1)).toEqual({ t: "closed", c });
  });

  it("closes a device that sends after its deadline before the alarm runs", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host();
    const { socket: device } = await harness.device(host);
    harness.now += 10_000;
    await harness.binary(device, Uint8Array.from([1]));
    expect(device.closed?.code).toBe(4408);
    expect(host.binaries()).toEqual([]);
  });
});

describe("frame and byte limits", () => {
  it("closes with 4413 for a payload over 1 MiB in either direction", async () => {
    const harness = new Harness(await hostKeys());
    const host = await harness.host();
    const { socket: device, c } = await harness.establish(host);
    await harness.binary(device, new Uint8Array(1024 * 1024));
    expect(host.binaries()[0]).toHaveLength(16 + 1024 * 1024);
    await harness.binary(device, new Uint8Array(1024 * 1024 + 1));
    expect(device.closed).toEqual({ code: 4413, reason: "frame too large" });
    expect(host.messages().at(-1)).toEqual({ t: "closed", c });
    const other = await harness.establish(host);
    const large = new Uint8Array(16 + 1024 * 1024 + 1);
    large.set(Buffer.from(other.c, "base64url"));
    await harness.binary(host, large);
    expect(other.socket.closed?.code).toBe(4413);
    expect(other.socket.binaries()).toEqual([]);
  });

  it("closes with 4429 when the per-minute byte budget runs out", async () => {
    const harness = new Harness(await hostKeys(), { minuteBytes: 100 });
    const host = await harness.host();
    const first = await harness.establish(host);
    await harness.binary(first.socket, new Uint8Array(60));
    await harness.binary(host, Uint8Array.from([...Buffer.from(first.c, "base64url"), ...new Uint8Array(40)]));
    expect(first.socket.closed).toBeNull();
    await harness.binary(first.socket, new Uint8Array(1));
    expect(first.socket.closed).toEqual({ code: 4429, reason: "byte limit" });
    expect(host.messages().at(-1)).toEqual({ t: "closed", c: first.c });
    await harness.advance(60_000);
    const second = await harness.establish(host);
    await harness.binary(second.socket, new Uint8Array(100));
    expect(second.socket.closed).toBeNull();
  });

  it("keeps the daily byte count in storage across hibernation and resets it the next UTC day", async () => {
    const harness = new Harness(await hostKeys(), { dayBytes: 150, dayFlushBytes: 64 });
    const host = await harness.host();
    const first = await harness.establish(host);
    await harness.binary(first.socket, new Uint8Array(50));
    expect(harness.state.puts).toBe(0);
    await harness.binary(first.socket, new Uint8Array(50));
    expect(harness.state.values.get("dayCount")).toEqual({ day: "2026-10-19", bytes: 100 });
    harness.wake();
    await harness.ready();
    await harness.binary(first.socket, new Uint8Array(60));
    expect(first.socket.closed).toEqual({ code: 4429, reason: "byte limit" });
    const second = await harness.establish(host);
    await harness.binary(second.socket, new Uint8Array(50));
    expect(harness.state.values.get("dayCount")).toEqual({ day: "2026-10-19", bytes: 100 });
    await harness.advance(60_000);
    expect(harness.state.values.get("dayCount")).toEqual({ day: "2026-10-19", bytes: 150 });
    const refused = await harness.open("/v1/connect");
    expect(refused.closed).toEqual({ code: 4429, reason: "byte limit" });
    harness.now = Date.UTC(2026, 9, 20, 0, 0, 0);
    const tomorrow = await harness.establish(host);
    await harness.binary(tomorrow.socket, new Uint8Array(150));
    expect(tomorrow.socket.closed).toBeNull();
  });
});
