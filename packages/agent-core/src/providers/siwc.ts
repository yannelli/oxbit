import { base64url } from "./http.js";

/** Sign in with ChatGPT endpoints and values from developers.openai.com/siwc/token-sharing-open-source, fetched 2026-10-11. */
export const CHATGPT = {
  issuer: "https://auth.openai.com",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  revoke: "https://auth.openai.com/api/accounts/oauth/revoke",
  jwks: "https://auth.openai.com/.well-known/jwks.json",
  resource: "https://api.openai.com/v1",
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  planScope: "chatgpt.tokens.use.direct",
  registrationClient: "dynamic_agent_client",
  agentName: "Oxbit Agent",
  port: 1455,
  callbackPath: "/auth/callback",
  usageUrl: "https://chatgpt.com/settings/usage",
} as const;
/** Labels from the SIWC UI/UX guidelines. */
export const CHATGPT_LABELS = { signIn: "Continue with ChatGPT", inUse: "Using ChatGPT plan", manage: "Manage usage", welcome: "You're using your ChatGPT plan" } as const;

/** One credential record per issued client ID, in the shape the SIWC sign-in page shows. */
export interface ChatGPTAccount {
  email?: string;
  issuer: string;
  subject: string;
  client_id: string;
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  /** Milliseconds since the epoch. */
  expires_at?: number;
  /** Seconds since the epoch, from the token response. */
  earliest_refresh_at?: number;
  scopes: string[];
  saved_at: string;
}
export interface ChatGPTRecord { ext_agent_host_id: string; active?: string; accounts: ChatGPTAccount[] }

export interface LoopbackRequest {
  query: Record<string, string>;
  respond(status: number, html: string): void;
}
export interface LoopbackServer {
  port: number;
  /** The next request to the callback path. Other paths get 404 from the host. */
  next(signal: AbortSignal): Promise<LoopbackRequest>;
  close(): Promise<void>;
}
/** The Node host's HTTP listener. */
export interface Loopback {
  /** Binds 127.0.0.1:`port` (0 picks a free port) and serves `path`. Rejects when the port is taken. */
  listen(port: number, path: string): Promise<LoopbackServer>;
}
export interface SignInOptions {
  loopback: Loopback;
  /** Opens the system browser at `url` or prints it. */
  open(url: string): void | Promise<void>;
  /** Issued client ID of a saved account to sign in again; omit to register a new one. */
  account?: string;
  /** Resolves with a callback URL the user pasted, for a browser on another machine. */
  paste?(signal: AbortSignal): Promise<string>;
  signal?: AbortSignal;
}

export const planEnabled = (account: ChatGPTAccount) => account.scopes.includes(CHATGPT.planScope);
const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
export const callbackPage = (text: string) => `<!doctype html><meta charset="utf-8"><title>Oxbit Agent</title><p>${escape(text)}</p>`;

export interface AuthorizeParams {
  /** The saved issued client ID; omit for first registration. */
  clientId?: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  idTokenHint?: string;
  loginHint?: string;
}
export function authorizeUrl(params: AuthorizeParams) {
  const query = new URLSearchParams({
    client_id: params.clientId ?? CHATGPT.registrationClient,
    ...(params.clientId ? {} : { agent_name_hint: CHATGPT.agentName }),
    ext_agent_host_id: params.hostId,
    ...(params.idTokenHint ? { id_token_hint: params.idTokenHint } : {}),
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
    response_type: "code", redirect_uri: params.redirectUri, scope: CHATGPT.scope, resource: CHATGPT.resource,
    state: params.state, nonce: params.nonce, code_challenge_method: "S256", code_challenge: params.challenge,
  });
  return `${CHATGPT.authorize}?${query}`;
}

export const pkceChallenge = async (verifier: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

const PLAN_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: `ChatGPT plan usage limit reached. ${CHATGPT_LABELS.manage}: ${CHATGPT.usageUrl}`,
  subscription_sharing_user_not_eligible: "ChatGPT plan usage is not available for this account or workspace.",
  subscription_sharing_usage_unavailable: "ChatGPT plan usage could not be checked. Try again later.",
  subscription_sharing_user_unavailable: "ChatGPT account information is unavailable. Try again later.",
  subscription_sharing_invalid_user: "ChatGPT could not validate this account. Sign in with ChatGPT again.",
  subscription_sharing_route_not_supported: "ChatGPT plan usage does not support this request route.",
};
/** A readable error body for plan requests, as `{error: {message}}` so modelError shows it. */
export function describePlanError(status: number, body: string) {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const code = parsed?.error?.code;
  const known = typeof code === "string" ? PLAN_ERRORS[code] : undefined;
  const text = known ?? (code === "subscription_sharing_unsupported_capability" ? `ChatGPT plan usage does not support ${parsed.error.param ?? "a field in this request"}.`
    : typeof parsed?.detail === "string" ? `ChatGPT plan request rejected (${status}): ${parsed.detail}` : undefined);
  return text ? JSON.stringify({ error: { message: text, code } }) : body;
}
