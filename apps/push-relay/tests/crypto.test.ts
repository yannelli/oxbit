import { PUSH_COLLAPSE_ID } from "@oxbit/sdk";
import { describe, expect, it } from "vitest";
import { COLLAPSE_ID, providerToken } from "../src/apns.js";
import { importHandleKey, openHandle, sealHandle } from "../src/handle.js";
import { ALERT_TOKEN, HANDLE_SECRET, apnsKeyPair, decodeSegment } from "./support.js";

describe("handles", () => {
  it("round-trips the token, environment and kind", async () => {
    const key = (await importHandleKey(HANDLE_SECRET))!;
    const device = { token: ALERT_TOKEN, environment: "development" as const, kind: "alert" as const };
    const handle = await sealHandle(key, device);
    expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(handle).not.toContain(ALERT_TOKEN);
    expect(await openHandle(key, handle)).toEqual(device);
    expect(await sealHandle(key, device)).not.toBe(handle);
  });

  it("rejects tampered handles and handles sealed with another secret", async () => {
    const key = (await importHandleKey(HANDLE_SECRET))!;
    const handle = await sealHandle(key, { token: ALERT_TOKEN, environment: "production", kind: "alert" });
    const bytes = Buffer.from(handle, "base64url");
    bytes[bytes.length - 1] ^= 1;
    expect(await openHandle(key, bytes.toString("base64url"))).toBeNull();
    expect(await openHandle(key, handle.slice(0, 10))).toBeNull();
    expect(await openHandle(key, "not a handle!")).toBeNull();
    const other = (await importHandleKey(Buffer.alloc(32, 9).toString("base64")))!;
    expect(await openHandle(other, handle)).toBeNull();
  });

  it("treats a missing or wrong-length secret as unconfigured", async () => {
    expect(await importHandleKey(undefined)).toBeNull();
    expect(await importHandleKey(Buffer.alloc(16).toString("base64"))).toBeNull();
    expect(await importHandleKey("%%%")).toBeNull();
  });
});

describe("provider token", () => {
  it("signs an ES256 JWT that verifies with the matching public key", async () => {
    const { pem, publicKey } = await apnsKeyPair();
    const jwt = await providerToken({ key: pem, keyId: "ABC123DEFG", teamId: "TEAM987654" }, 1_800_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(decodeSegment(claims)).toEqual({ iss: "TEAM987654", iat: 1_800_000_000 });
    const raw = Buffer.from(signature, "base64url");
    expect(raw).toHaveLength(64);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      raw,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("uses the SDK collapse id", () => {
    expect(COLLAPSE_ID).toBe(PUSH_COLLAPSE_ID);
  });
});
