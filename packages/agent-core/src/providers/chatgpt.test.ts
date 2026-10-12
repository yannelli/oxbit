import { describe, expect, it, vi } from "vitest";
import { ChatGPTAuth } from "./chatgpt.js";
import { base64url, type AuthStore } from "./http.js";
import { provider } from "./registry.js";
import { CHATGPT, pkceChallenge, planEnabled, type ChatGPTRecord, type Loopback, type LoopbackRequest } from "./siwc.js";

const CLIENT = "oaiapp_test123";
const memoryStore = (): AuthStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (key) => data.get(key), set: async (key, value) => void data.set(key, value), delete: async (key) => void data.delete(key) };
};
const stored = (store: { data: Map<string, string> }): ChatGPTRecord => JSON.parse(store.data.get("chatgpt")!);

async function signingKey(kid = "k1") {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, use: "sig", alg: "RS256" };
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const sign = async (claims: Record<string, unknown>) => {
    const input = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
    return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input))))}`;
  };
  return { jwk, sign };
}

/** A fake auth.openai.com, a loopback listener, and a browser that follows the authorize URL. */
async function setup(options: { busyPort?: boolean } = {}) {
  let now = Date.UTC(2026, 9, 11);
  const key = await signingKey();
  const server = {
    scope: CHATGPT.scope as string, callbackClient: CLIENT as string | undefined, refreshError: undefined as string | undefined,
    sign: key.sign, refresh: "", issued: 0, claims: {} as Record<string, unknown>,
    pending: undefined as undefined | { challenge: string; nonce: string; redirect: string },
    authorize: [] as URLSearchParams[], tokens: [] as URLSearchParams[], revoked: [] as URLSearchParams[], models: [] as string[],
  };
  const issue = async (extra: Record<string, unknown> = {}) => {
    server.issued++;
    server.refresh = `R${server.issued}`;
    return Response.json({ access_token: `A${server.issued}`, refresh_token: server.refresh, expires_in: 3600, token_type: "Bearer", ...extra });
  };
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === CHATGPT.jwks) return Response.json({ keys: [key.jwk] });
    if (url === "https://api.openai.com/v1/models") {
      const token = new Headers(init.headers).get("authorization")!;
      server.models.push(token);
      return token === `Bearer A${server.issued}` && server.models.length > 1
        ? Response.json({ models: [{ slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list", context_window: 1050000 }] })
        : new Response('{"error":{"message":"expired"}}', { status: 401 });
    }
    const form = new URLSearchParams(String(init.body));
    if (url === CHATGPT.revoke) {
      server.revoked.push(form);
      return new Response(null, { status: 200 });
    }
    if (url !== CHATGPT.token) throw new Error(`Unexpected fetch ${url}`);
    server.tokens.push(form);
    if (form.get("grant_type") === "authorization_code") {
      const pending = server.pending!;
      const valid = form.get("code") === "code-1" && form.get("redirect_uri") === pending.redirect && form.get("client_id") === CLIENT
        && form.get("resource") === CHATGPT.resource && await pkceChallenge(form.get("code_verifier") ?? "") === pending.challenge;
      if (!valid) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const second = Math.floor(now / 1000);
      const id_token = await server.sign({ iss: CHATGPT.issuer, aud: CLIENT, sub: "user-1", email: "me@example.com", nonce: pending.nonce, iat: second,
        exp: second + 3600, ...server.claims });
      return issue({ id_token, scope: server.scope });
    }
    if (server.refreshError) return Response.json({ error: server.refreshError }, { status: 400 });
    if (form.get("refresh_token") !== server.refresh) return Response.json({ error: "refresh_token_reused" }, { status: 400 });
    return issue();
  });
  const responses: [number, string][] = [];
  const ports: number[] = [];
  const queue: LoopbackRequest[] = [];
  let wake: (() => void) | undefined;
  const deliver = (query: Record<string, string>) => {
    queue.push({ query, respond: (status, html) => void responses.push([status, html]) });
    wake?.();
  };
  const loopback: Loopback = { listen: async (port, path) => {
    ports.push(port);
    if (options.busyPort && port === CHATGPT.port) throw new Error("EADDRINUSE");
    expect(path).toBe("/auth/callback");
    return { port: port || 50123, close: async () => {}, next: async (signal) => {
      while (!queue.length) {
        if (signal.aborted) throw new Error("closed");
        await new Promise<void>((resolve) => (wake = resolve));
      }
      return queue.shift()!;
    } };
  } };
  const open = vi.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    server.authorize.push(params);
    server.pending = { challenge: params.get("code_challenge")!, nonce: params.get("nonce")!, redirect: params.get("redirect_uri")! };
    deliver({ code: "code-1", state: params.get("state")!, ...server.callbackClient ? { client_id: server.callbackClient } : {} });
  });
  const store = memoryStore();
  const auth = new ChatGPTAuth({ fetch, store, now: () => now });
  return { auth, store, server, fetch, loopback, open, deliver, responses, ports, advance: (ms: number) => void (now += ms) };
}

describe("Sign in with ChatGPT", () => {
  it("registers with dynamic_agent_client and PKCE, then signs in again with the issued client", async () => {
    const t = await setup();
    const account = await t.auth.signIn({ loopback: t.loopback, open: t.open });
    expect([account.client_id, account.subject, account.email, planEnabled(account)]).toEqual([CLIENT, "user-1", "me@example.com", true]);
    const record = stored(t.store);
    expect(record.ext_agent_host_id).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(record.active).toBe(CLIENT);
    const first = t.server.authorize[0];
    expect(t.open.mock.calls[0][0].startsWith(`${CHATGPT.authorize}?`)).toBe(true);
    expect(t.open.mock.calls[0][0]).not.toContain("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(Object.fromEntries(first)).toMatchObject({ client_id: "dynamic_agent_client", agent_name_hint: "Oxbit Agent", ext_agent_host_id: record.ext_agent_host_id,
      response_type: "code", redirect_uri: "http://127.0.0.1:1455/auth/callback", scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1", code_challenge_method: "S256" });
    expect(first.get("state")!.length).toBeGreaterThanOrEqual(43);
    expect(first.get("nonce")).not.toBe(first.get("state"));
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(t.responses).toEqual([[200, expect.stringContaining("connected to your ChatGPT plan")]]);
    await t.auth.signIn({ loopback: t.loopback, open: t.open, account: CLIENT });
    const again = Object.fromEntries(t.server.authorize[1]);
    expect(again).toMatchObject({ client_id: CLIENT, ext_agent_host_id: record.ext_agent_host_id, login_hint: "me@example.com", id_token_hint: account.id_token });
    expect(again.agent_name_hint).toBeUndefined();
    expect(again.state).not.toBe(first.get("state"));
  });

  it("answers a callback from another attempt with 400 and keeps waiting", async () => {
    const t = await setup();
    t.open.mockImplementationOnce(async (url: string) => {
      const params = new URL(url).searchParams;
      t.server.pending = { challenge: params.get("code_challenge")!, nonce: params.get("nonce")!, redirect: params.get("redirect_uri")! };
      t.deliver({ code: "code-1", state: "stale", client_id: CLIENT });
      setTimeout(() => t.deliver({ code: "code-1", state: params.get("state")!, client_id: CLIENT }), 5);
    });
    await t.auth.signIn({ loopback: t.loopback, open: t.open });
    expect(t.responses.map(([status]) => status)).toEqual([400, 200]);
    expect(t.responses[0][1]).toContain("another sign-in attempt");
  });

  it.each([
    ["a different nonce", { nonce: "other" }, "nonce does not match"],
    ["another audience", { aud: "oaiapp_other" }, "audience does not match"],
    ["another issuer", { iss: "https://evil.example.com" }, "issuer does not match"],
    ["an expired token", { exp: Math.floor(Date.UTC(2026, 9, 11) / 1000) - 60 }, "has expired"],
  ])("rejects an ID token with %s", async (_label, claims, error) => {
    const t = await setup();
    t.server.claims = claims;
    await expect(t.auth.signIn({ loopback: t.loopback, open: t.open })).rejects.toThrow(error);
    expect(t.responses[0][0]).toBe(400);
    expect(stored(t.store).accounts).toEqual([]);
  });

  it("rejects an ID token signed by another key", async () => {
    const t = await setup();
    t.server.sign = (await signingKey("k1")).sign;
    await expect(t.auth.signIn({ loopback: t.loopback, open: t.open })).rejects.toThrow("signature is invalid");
  });

  it("keeps a sign-in without the plan scope and disables plan use", async () => {
    const t = await setup();
    t.server.scope = "openid profile email offline_access";
    const account = await t.auth.signIn({ loopback: t.loopback, open: t.open });
    expect(planEnabled(account)).toBe(false);
    expect(t.responses[0][1]).toContain("plan use was not allowed");
    await expect(t.auth.accessToken()).rejects.toThrow("ChatGPT plan use is not enabled");
  });

  it("rejects a missing issued client and a reauthorization for a different client", async () => {
    const t = await setup();
    t.server.callbackClient = undefined;
    await expect(t.auth.signIn({ loopback: t.loopback, open: t.open })).rejects.toThrow("did not return an issued client ID");
    t.server.callbackClient = CLIENT;
    await t.auth.signIn({ loopback: t.loopback, open: t.open });
    t.server.callbackClient = "oaiapp_other";
    await expect(t.auth.signIn({ loopback: t.loopback, open: t.open, account: CLIENT })).rejects.toThrow("different client");
  });

  it("falls back to a free port when 1455 is taken", async () => {
    const t = await setup({ busyPort: true });
    await t.auth.signIn({ loopback: t.loopback, open: t.open });
    expect(t.ports).toEqual([1455, 0]);
    expect(t.server.tokens[0].get("redirect_uri")).toBe("http://127.0.0.1:50123/auth/callback");
  });

  it("rotates refresh tokens with one refresh at a time", async () => {
    const t = await setup();
    await t.auth.signIn({ loopback: t.loopback, open: t.open });
    expect(await t.auth.accessToken()).toBe("A1");
    t.advance(3600000 - 60000);
    expect(await Promise.all([t.auth.accessToken(), t.auth.accessToken()])).toEqual(["A2", "A2"]);
    const refresh = t.server.tokens.filter((form) => form.get("grant_type") === "refresh_token");
    expect(refresh.map((form) => Object.fromEntries(form))).toEqual([{ grant_type: "refresh_token", client_id: CLIENT, refresh_token: "R1", resource: CHATGPT.resource }]);
    t.advance(3600000);
    expect(await t.auth.accessToken()).toBe("A3");
    expect(t.server.tokens.at(-1)!.get("refresh_token")).toBe("R2");
    expect(stored(t.store).accounts[0]).toMatchObject({ access_token: "A3", refresh_token: "R3", client_id: CLIENT });
  });

  it("clears tokens when the refresh token is unusable", async () => {
    const t = await setup();
    await t.auth.signIn({ loopback: t.loopback, open: t.open });
    t.server.refreshError = "invalid_grant";
    await expect(t.auth.accessToken(true)).rejects.toThrow("expired or was revoked");
    expect(stored(t.store).accounts[0]).toMatchObject({ client_id: CLIENT });
    expect(stored(t.store).accounts[0].refresh_token).toBeUndefined();
    await expect(t.auth.accessToken()).rejects.toThrow("has ended");
  });

  it("retries a plan request once with a refreshed token after a 401", async () => {
    const t = await setup();
    await t.auth.signIn({ loopback: t.loopback, open: t.open });
    const runtime = provider({ provider: "openai", method: "chatgpt" }, { fetch: t.fetch, auth: t.store, chatgpt: t.auth });
    expect(runtime.label).toBe("Using ChatGPT plan");
    expect(await runtime.catalog()).toEqual([{ id: "gpt-6-sol", name: "GPT-6 Sol", contextWindow: 1050000, maxOutput: 128000 }]);
    expect(t.server.models).toEqual(["Bearer A1", "Bearer A2"]);
  });

  it("revokes the refresh token on sign-out and keeps the client and host IDs", async () => {
    const t = await setup();
    await t.auth.signIn({ loopback: t.loopback, open: t.open });
    const hostId = stored(t.store).ext_agent_host_id;
    expect(await t.auth.signOut(0)).toEqual({ revoked: true });
    expect(Object.fromEntries(t.server.revoked[0])).toEqual({ token: "R1", token_type_hint: "refresh_token", client_id: CLIENT });
    const record = stored(t.store);
    expect([record.ext_agent_host_id, record.active, record.accounts[0].client_id, record.accounts[0].access_token]).toEqual([hostId, undefined, CLIENT, undefined]);
  });
});
