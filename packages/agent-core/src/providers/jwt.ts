import { fromBase64url, type Fetch } from "./http.js";

export interface JwksSource {
  /** Signing keys; `refresh` skips the cache after an unknown `kid`. */
  keys(refresh: boolean): Promise<JsonWebKey[]>;
}

/** JWKS fetched through the host and cached for an hour. */
export function remoteJwks(fetch: Fetch, url: string, now: () => number = Date.now): JwksSource {
  let cached: { keys: JsonWebKey[]; at: number } | undefined;
  return {
    async keys(refresh) {
      if (cached && !refresh && now() - cached.at < 3600000) return cached.keys;
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`The signing keys could not be loaded (HTTP ${response.status})`);
      const body = await response.json();
      if (!Array.isArray(body?.keys)) throw new Error("The signing key set has no keys");
      cached = { keys: body.keys, at: now() };
      return cached.keys;
    },
  };
}

export interface IdTokenCheck {
  issuer: string;
  /** The issued client ID the token must be addressed to. */
  audience: string;
  nonce: string;
  jwks: JwksSource;
  now?(): number;
  /** Clock skew in seconds. The SIWC example allows 5. */
  skew?: number;
}

const json = (part: string) => {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  } catch {
    throw new Error("The ID token is malformed");
  }
};

/** Verifies an RS256 ID token with WebCrypto: signature against the JWKS, issuer, audience, expiry, issued-at, nonce and subject. */
export async function verifyIdToken(token: string, check: IdTokenCheck): Promise<Record<string, any>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("The ID token is malformed");
  const header = json(parts[0]);
  const claims = json(parts[1]);
  if (header?.alg !== "RS256") throw new Error(`The ID token uses an unsupported algorithm: ${header?.alg}`);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = fromBase64url(parts[2]);
  const matches = (keys: JsonWebKey[]) => keys.filter((key: any) => key.kty === "RSA" && (!key.use || key.use === "sig")
    && (!key.alg || key.alg === "RS256") && (header.kid === undefined || key.kid === header.kid));
  let candidates = matches(await check.jwks.keys(false));
  if (!candidates.length) candidates = matches(await check.jwks.keys(true));
  if (!candidates.length) throw new Error("No signing key matches the ID token");
  let valid = false;
  for (const jwk of candidates) {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed)) {
      valid = true;
      break;
    }
  }
  if (!valid) throw new Error("The ID token signature is invalid");
  const now = Math.floor((check.now?.() ?? Date.now()) / 1000);
  const skew = check.skew ?? 5;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== check.issuer) throw new Error("The ID token issuer does not match");
  if (!audience.includes(check.audience) || (audience.length > 1 && claims.azp !== check.audience))
    throw new Error("The ID token audience does not match this client");
  if (!Number.isFinite(claims.exp) || claims.exp + skew < now) throw new Error("The ID token has expired");
  if (!Number.isFinite(claims.iat) || claims.iat - skew > now) throw new Error("The ID token issue time is invalid");
  if (claims.nonce !== check.nonce) throw new Error("The ID token nonce does not match this sign-in attempt");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("The ID token has no subject");
  return claims;
}
