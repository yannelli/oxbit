import crypto from "node:crypto";
import fs from "node:fs";

export function createAppStoreConnectApi(env = process.env, fetchApi = fetch, now = Date.now) {
  const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH } = env;
  for (const [name, value] of Object.entries({ APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH }))
    if (!value) throw new Error(`Set ${name}`);
  const key = fs.readFileSync(APPLE_API_KEY_PATH);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return async (method, path, body) => {
    const url = new URL(path, "https://api.appstoreconnect.apple.com");
    if (url.origin !== "https://api.appstoreconnect.apple.com" || !url.pathname.startsWith("/v1/"))
      throw new Error("Unexpected App Store Connect URL");
    const issued = Math.floor(now() / 1000);
    const unsigned = `${encode({ alg: "ES256", kid: APPLE_API_KEY, typ: "JWT" })}.${encode({ iss: APPLE_API_ISSUER, iat: issued, exp: issued + 600, aud: "appstoreconnect-v1" })}`;
    const signature = crypto.sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const response = await fetchApi(url, {
      method,
      headers: { Authorization: `Bearer ${unsigned}.${signature}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok)
      throw Object.assign(new Error(`App Store Connect ${method} ${url.pathname} returned ${response.status}: ${await response.text()}`), { status: response.status });
    return response.status === 204 ? undefined : response.json();
  };
}
