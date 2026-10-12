// The built-in Oxbit agent runs in the app and calls a model API with the user's key.
// The iOS host registers AGENT_MODELS_SERVICE for local files and runtime workspaces, which use it for conversation titles.
export const OXBIT_AGENT_PROVIDER = "oxbit";
export const AGENT_MODELS_SERVICE = "agentModels";
export const MISSING_AGENT_KEY = "Add an API key in Agent setup";
export const MISSING_CHATGPT_SIGN_IN = "Sign in with ChatGPT in Agent setup";

/** `openai`: Responses API. `openai-compatible`: Chat Completions at `baseUrl`. `anthropic`: Messages API.
 * `chatgpt`: the ChatGPT plan's Codex Responses API at https://chatgpt.com/backend-api, signed in with a device code. */
export type AgentModelApi = "openai" | "anthropic" | "openai-compatible" | "chatgpt";

/** Settings read by the Oxbit agent. The key lives in the host's keychain. */
export const OXBIT_AGENT_SETTINGS = {
  api: "agentACP.oxbit.api",
  baseUrl: "agentACP.oxbit.baseUrl",
  model: "agentACP.oxbit.model",
} as const;

export interface AgentModelEndpoint {
  api: AgentModelApi;
  /** Required for `openai-compatible`: origin plus path prefix, for example `https://openrouter.ai/api`. */
  baseUrl?: string;
}

export interface AgentModelRequest extends AgentModelEndpoint {
  method: "GET" | "POST";
  /** Path under the API base, for example `/v1/responses` or `/v1/models`. */
  path: string;
  /** JSON body for POST. */
  body?: unknown;
}

/** Thrown by `stream` for a non-2xx response; `body` is the response text. */
export interface AgentModelError extends Error {
  status: number;
  body: string;
  /** The response's Retry-After, when the host reads headers. */
  retryAfterMs?: number;
}

/** A ChatGPT sign-in waiting for the user to enter `userCode` at `verificationUrl`. */
export interface ChatGPTDeviceCode {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  /** Seconds between polls. */
  interval: number;
  /** Epoch milliseconds after which the code is no longer accepted. */
  expiresAt: number;
}

/** Device code sign-in for the `chatgpt` endpoint. The host keeps the tokens; `keys.has` reports a sign-in and `keys.remove` signs out. */
export interface ChatGPTSignIn {
  start(signal?: AbortSignal): Promise<ChatGPTDeviceCode>;
  /** One poll. On `complete` the host has exchanged the code and saved the tokens. */
  poll(device: ChatGPTDeviceCode, signal?: AbortSignal): Promise<"pending" | "slow_down" | "complete">;
}

/** Host service under `AGENT_MODELS_SERVICE`. It adds the endpoint's saved key and pins requests to its origin. */
export interface AgentModels {
  /** Sends `request` and yields the response body's text as it arrives. */
  stream(request: AgentModelRequest, signal?: AbortSignal): AsyncIterable<string>;
  keys: {
    has(endpoint: AgentModelEndpoint): Promise<boolean>;
    save(endpoint: AgentModelEndpoint, key: string): Promise<void>;
    remove(endpoint: AgentModelEndpoint): Promise<void>;
  };
  /** Present when the host supports the `chatgpt` endpoint. */
  chatgpt?: ChatGPTSignIn;
}
