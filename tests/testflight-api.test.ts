import { afterEach, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain-node release script without types
import { createAppStoreConnectApi } from "../scripts/ios/app-store-connect.mjs";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function credentials() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxbit-asc-test-"));
  temporary.push(dir);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyPath = path.join(dir, "test.p8");
  fs.writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  return { env: { APPLE_API_KEY: "test-id", APPLE_API_ISSUER: "test-issuer", APPLE_API_KEY_PATH: keyPath }, publicKey };
}

it("signs a fresh JWT for each request after a long processing wait and handles empty assignment responses", async () => {
  const { env, publicKey } = credentials();
  const fetchApi = vi.fn(async (_url: URL, _request: RequestInit) => new Response(null, { status: 204 }));
  let time = 1_800_000_000_000;
  const api = createAppStoreConnectApi(env, fetchApi, () => time);
  await expect(api("POST", "/v1/betaGroups/group/relationships/builds", { data: [{ id: "build", type: "builds" }] })).resolves.toBeUndefined();
  time += 20 * 60_000;
  await api("GET", "/v1/builds");
  for (const [index, [url, request]] of fetchApi.mock.calls.entries()) {
    expect(url.origin).toBe("https://api.appstoreconnect.apple.com");
    expect(request.redirect).toBe("error");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const token = (request.headers as Record<string, string>).Authorization.slice(7);
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({ iss: "test-issuer", aud: "appstoreconnect-v1", iat: 1_800_000_000 + index * 1200 });
    expect(claims.exp - claims.iat).toBe(600);
    expect(crypto.verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
  }
  expect(fetchApi.mock.calls[0][1].body).toBe('{"data":[{"id":"build","type":"builds"}]}');
});

it("rejects pagination outside Apple's API before sending credentials", async () => {
  const { env } = credentials();
  const fetchApi = vi.fn();
  const api = createAppStoreConnectApi(env, fetchApi);
  await expect(api("GET", "https://example.com/v1/builds")).rejects.toThrow("Unexpected App Store Connect URL");
  expect(fetchApi).not.toHaveBeenCalled();
});

it("surfaces API failures with their status", async () => {
  const { env } = credentials();
  const api = createAppStoreConnectApi(env, async () => new Response("Permission denied", { status: 403 }));
  await expect(api("GET", "/v1/builds")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("Permission denied") });
});
