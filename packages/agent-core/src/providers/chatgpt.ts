import { bodyText, randomToken, type AuthStore, type Fetch } from "./http.js";
import { remoteJwks, verifyIdToken, type JwksSource } from "./jwt.js";
import { CHATGPT, CHATGPT_LABELS, authorizeUrl, callbackPage, pkceChallenge, planEnabled, type ChatGPTAccount, type ChatGPTRecord,
  type LoopbackRequest, type LoopbackServer, type SignInOptions } from "./siwc.js";

export interface ChatGPTOptions {
  fetch: Fetch;
  store: AuthStore;
  now?(): number;
  jwks?: JwksSource;
}

const STORE_KEY = "chatgpt";
const MARGIN = 300000;
const UNUSABLE = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Sign in with ChatGPT for plan usage: registration, sign-in, ID token checks, refresh rotation and sign-out. */
export class ChatGPTAuth {
  private jwks: JwksSource;
  private refreshing = new Map<string, Promise<string>>();
  constructor(private options: ChatGPTOptions) {
    this.jwks = options.jwks ?? remoteJwks(options.fetch, CHATGPT.jwks, options.now);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  /** The stored record. Creates the stable `ext_agent_host_id` on first use. */
  async record(): Promise<ChatGPTRecord> {
    let record: ChatGPTRecord | undefined;
    try {
      record = JSON.parse((await this.options.store.get(STORE_KEY)) ?? "null");
    } catch {
      record = undefined;
    }
    if (record && typeof record.ext_agent_host_id === "string" && Array.isArray(record.accounts)) return record;
    record = { ext_agent_host_id: `urn:uuid:${crypto.randomUUID()}`, accounts: [] };
    await this.save(record);
    return record;
  }
  private save(record: ChatGPTRecord) {
    return this.options.store.set(STORE_KEY, JSON.stringify(record, null, 2));
  }
  /** The active account, or the one with `clientId`. */
  async account(clientId?: string) {
    const record = await this.record();
    return record.accounts.find((account) => account.client_id === (clientId ?? record.active));
  }
  async signIn(options: SignInOptions): Promise<ChatGPTAccount> {
    const record = await this.record();
    const saved = options.account ? record.accounts.find((account) => account.client_id === options.account) : undefined;
    if (options.account && !saved) throw new Error("This ChatGPT account is not saved on this computer");
    const verifier = randomToken();
    const state = randomToken();
    const nonce = randomToken();
    const server = await options.loopback.listen(CHATGPT.port, CHATGPT.callbackPath)
      .catch(() => options.loopback.listen(0, CHATGPT.callbackPath));
    const redirectUri = `http://127.0.0.1:${server.port}${CHATGPT.callbackPath}`;
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    try {
      await options.open(authorizeUrl({ clientId: saved?.client_id, hostId: record.ext_agent_host_id, redirectUri, state, nonce,
        challenge: await pkceChallenge(verifier), idTokenHint: saved?.id_token, loginHint: saved?.email }));
      const callback = await this.callback(server, options, state, redirectUri, signal);
      try {
        const account = await this.complete(callback.query, saved, redirectUri, verifier, nonce);
        callback.respond(200, callbackPage(planEnabled(account) ? "Oxbit Agent is connected to your ChatGPT plan. You can close this window."
          : "You are signed in, but ChatGPT plan use was not allowed. Return to Oxbit Agent."));
        return account;
      } catch (error) {
        callback.respond(400, callbackPage(message(error)));
        throw error;
      }
    } finally {
      abort.abort();
      await server.close().catch(() => {});
    }
  }
  /** Waits for a callback with this attempt's state. Callbacks from other attempts get a 400 and the wait goes on. */
  private async callback(server: LoopbackServer, options: SignInOptions, state: string, redirectUri: string, signal: AbortSignal) {
    const pasted = options.paste?.(signal).then((text): LoopbackRequest & { pasted: true } => {
      const url = new URL(text.trim());
      if (`${url.origin}${url.pathname}` !== redirectUri) throw new Error(`Paste the full callback URL that starts with ${redirectUri}`);
      return { query: Object.fromEntries(url.searchParams), respond: () => {}, pasted: true };
    });
    pasted?.catch(() => {});
    for (;;) {
      const next = server.next(signal);
      next.catch(() => {});
      const request: LoopbackRequest & { pasted?: true } = await (pasted ? Promise.race([next, pasted]) : next);
      if (request.query.state === state) return request;
      if (request.pasted) throw new Error("The pasted URL belongs to another sign-in attempt");
      request.respond(400, callbackPage("This link belongs to another sign-in attempt. Return to Oxbit Agent and try again."));
    }
  }
  private async complete(query: Record<string, string>, saved: ChatGPTAccount | undefined, redirectUri: string, verifier: string, nonce: string) {
    if (query.error) throw new Error(query.error === "access_denied" ? "The ChatGPT sign-in was declined, so ChatGPT plan use is not enabled."
      : `ChatGPT sign-in failed: ${query.error_description || query.error}`);
    if (!query.code) throw new Error("The ChatGPT callback has no authorization code");
    const returned = query.client_id?.trim();
    if (saved && returned && returned !== saved.client_id) throw new Error("ChatGPT returned a different client for this account. Sign in again.");
    const clientId = saved?.client_id ?? returned;
    if (!clientId || clientId === CHATGPT.registrationClient) throw new Error("ChatGPT did not return an issued client ID, so registration is incomplete. Sign in again.");
    const tokens = await this.tokenRequest({ grant_type: "authorization_code", client_id: clientId, code: query.code,
      code_verifier: verifier, redirect_uri: redirectUri, resource: CHATGPT.resource });
    if (typeof tokens.id_token !== "string" || !tokens.id_token) throw new Error("The ChatGPT token response has no ID token");
    const claims = await verifyIdToken(tokens.id_token, { issuer: CHATGPT.issuer, audience: clientId, nonce, jwks: this.jwks, now: this.options.now });
    if (saved && claims.sub !== saved.subject) throw new Error("This sign-in belongs to a different ChatGPT account than the one selected");
    const account: ChatGPTAccount = { ...(typeof claims.email === "string" ? { email: claims.email } : {}), issuer: CHATGPT.issuer,
      subject: claims.sub, client_id: clientId, id_token: tokens.id_token, ...this.tokenFields(tokens) };
    const record = await this.record();
    record.accounts = [...record.accounts.filter((item) => item.client_id !== clientId), account];
    record.active = clientId;
    await this.save(record);
    return account;
  }
  private tokenFields(tokens: Record<string, any>, previous?: ChatGPTAccount) {
    if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("The ChatGPT token response has no access token");
    const refresh = typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : previous?.refresh_token;
    if (!refresh) throw new Error("The ChatGPT token response has no refresh token");
    const expiresIn = Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? tokens.expires_in as number : 3600;
    const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
    const earliest = Number.isFinite(tokens.earliest_refresh_at) ? tokens.earliest_refresh_at as number : undefined;
    return { access_token: tokens.access_token as string, refresh_token: refresh, token_type: typeof tokens.token_type === "string" ? tokens.token_type : "Bearer",
      expires_in: expiresIn, expires_at: this.now() + expiresIn * 1000, earliest_refresh_at: earliest, scopes, saved_at: new Date(this.now()).toISOString() };
  }
  private async tokenRequest(form: Record<string, string>): Promise<Record<string, any>> {
    const response = await this.options.fetch(CHATGPT.token, { method: "POST", body: new URLSearchParams(form).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" } });
    const text = await bodyText(response);
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (response.ok && body && typeof body === "object") return body;
    const code = typeof body?.error === "string" ? body.error : body?.error?.code;
    const detail = body?.error_description ?? body?.error?.message ?? (typeof code === "string" ? code : `HTTP ${response.status}`);
    throw Object.assign(new Error(`The ChatGPT token request failed: ${detail}`), { code, status: response.status });
  }
  private fresh(account: ChatGPTAccount) {
    const now = this.now();
    if (!account.access_token || !account.expires_at || now >= account.expires_at) return false;
    const earliest = account.earliest_refresh_at === undefined ? 0 : account.earliest_refresh_at * (account.earliest_refresh_at > 1e12 ? 1 : 1000);
    return now < account.expires_at - MARGIN || now < earliest;
  }
  /** A valid access token for the active account. Refreshes near expiry; `force` refreshes after a 401. One refresh runs at a time. */
  async accessToken(force = false): Promise<string> {
    const account = await this.account();
    if (!account) throw new Error(`Sign in with ChatGPT first (${CHATGPT_LABELS.signIn}).`);
    if (!planEnabled(account)) throw new Error("ChatGPT plan use is not enabled for this sign-in. Sign in again and allow it, or use an OpenAI API key.");
    if (!account.access_token || !account.refresh_token) throw new Error("The ChatGPT sign-in has ended. Sign in with ChatGPT again.");
    if (!force && this.fresh(account)) return account.access_token;
    let pending = this.refreshing.get(account.client_id);
    if (!pending) {
      pending = this.refresh(account.client_id, force ? account.access_token : undefined).finally(() => this.refreshing.delete(account.client_id));
      this.refreshing.set(account.client_id, pending);
    }
    return pending;
  }
  private refresh(clientId: string, rejected?: string) {
    const run = async () => {
      const record = await this.record();
      const account = record.accounts.find((item) => item.client_id === clientId);
      if (!account?.refresh_token) throw new Error("The ChatGPT sign-in has ended. Sign in with ChatGPT again.");
      if (account.access_token && account.access_token !== rejected && this.fresh(account)) return account.access_token;
      let tokens: Record<string, any>;
      try {
        tokens = await this.tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: account.refresh_token, resource: CHATGPT.resource });
      } catch (error: any) {
        if (UNUSABLE.has(error?.code)) {
          Object.assign(account, { access_token: undefined, refresh_token: undefined, expires_at: undefined });
          await this.save(record);
          throw new Error("The ChatGPT sign-in expired or was revoked. Sign in with ChatGPT again.");
        }
        if (error?.code === "invalid_client") throw new Error("ChatGPT rejected this client ID (invalid_client). Sign in with ChatGPT again to register Oxbit Agent.");
        throw error;
      }
      Object.assign(account, this.tokenFields(tokens, account), typeof tokens.id_token === "string" ? { id_token: tokens.id_token } : {});
      await this.save(record);
      return account.access_token!;
    };
    return this.options.store.lock ? this.options.store.lock(STORE_KEY, run) : run();
  }
  /** Revokes the refresh token, then clears the active account's tokens. Keeps the client ID and host ID for a later sign-in. */
  async signOut(retryDelayMs = 500): Promise<{ revoked: boolean }> {
    const record = await this.record();
    const account = record.accounts.find((item) => item.client_id === record.active);
    if (!account) return { revoked: true };
    let revoked = !account.refresh_token;
    for (let attempt = 0; !revoked && attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      try {
        const response = await this.options.fetch(CHATGPT.revoke, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: account.refresh_token!, token_type_hint: "refresh_token", client_id: account.client_id }).toString() });
        await response.body?.cancel().catch(() => {});
        if (response.ok) revoked = true;
        else if (response.status < 500) break;
      } catch {
        // A network failure retries while the refresh token is still available.
      }
    }
    Object.assign(account, { access_token: undefined, refresh_token: undefined, id_token: undefined, expires_at: undefined });
    record.active = undefined;
    await this.save(record);
    return { revoked };
  }
}
