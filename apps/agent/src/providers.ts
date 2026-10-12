import type { AgentModelEndpoint, AgentModelRequest, AgentModels } from "@oxbit/sdk";
import type { AgentSettings } from "./config.js";

export const PROVIDERS = ["openai", "anthropic", "openrouter", "ollama", "openai-compatible"] as const;
export type ProviderId = typeof PROVIDERS[number];
const ENV_KEYS: Partial<Record<ProviderId, string>> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const BASES: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com", anthropic: "https://api.anthropic.com", openrouter: "https://openrouter.ai/api", ollama: "http://127.0.0.1:11434/v1",
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ERROR_BODY_LIMIT = 64 * 1024;

export interface ProviderChoice {
  id: ProviderId;
  endpoint: AgentModelEndpoint;
  /** Origin plus path prefix; request paths such as /v1/models append to it. */
  base: string;
  key?: string;
  /** The model from --model or settings for this provider. */
  model?: string;
}
export interface ProviderInput {
  provider?: string;
  model?: string;
  settings: AgentSettings;
  env: NodeJS.ProcessEnv;
  /** Stored API key from auth.json. */
  storedKey(provider: string): string | undefined;
}

/** https, or http on a loopback host. A trailing /v1 is dropped because the adapters send /v1/... paths. */
export function normalizeBase(input: string) {
  let url: URL;
  try {
    url = new URL(/^[a-z][\w+.-]*:\/\//i.test(input) ? input : `http://${input}`);
  } catch {
    throw new Error(`Invalid base URL: ${input}`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Use a base URL without credentials, a query, or a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    throw new Error("Use an https:// base URL, or http:// on localhost");
  if (url.pathname.includes("..")) throw new Error("The base URL path cannot contain \"..\"");
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
}

/** Provider, endpoint, key and model from flags, settings.json, auth.json and the environment. */
export function selectProvider({ provider, model, settings, env, storedKey }: ProviderInput): ProviderChoice {
  const keyOf = (id: ProviderId) => (ENV_KEYS[id] && env[ENV_KEYS[id]!]) || storedKey(id) || settings.providers?.[id]?.apiKey || undefined;
  const detected = (["anthropic", "openai", "openrouter"] as const).find((id) => keyOf(id));
  const name = provider || settings.provider || detected || "ollama";
  if (!PROVIDERS.includes(name as ProviderId)) throw new Error(`Unknown provider ${name}. Use one of: ${PROVIDERS.join(", ")}`);
  const id = name as ProviderId;
  const own = settings.providers?.[id] ?? {};
  const fromEnv = id === "ollama" ? env.OLLAMA_HOST : id === "openai-compatible" ? env.OXBIT_AGENT_BASE_URL : undefined;
  const configured = id === "openai" || id === "anthropic" ? BASES[id] : own.baseUrl || fromEnv || BASES[id];
  if (!configured) throw new Error("Set providers[\"openai-compatible\"].baseUrl in settings.json or OXBIT_AGENT_BASE_URL");
  const base = normalizeBase(configured);
  const endpoint: AgentModelEndpoint = id === "openai" || id === "anthropic" ? { api: id } : { api: "openai-compatible", baseUrl: base };
  const saved = own.model || (settings.provider === id || !settings.provider ? settings.model : undefined);
  return { id, endpoint, base, key: keyOf(id), model: model || saved || undefined };
}

export const needsKey = (choice: ProviderChoice) => choice.id !== "ollama" && choice.id !== "openai-compatible";
export function missingKey(choice: ProviderChoice) {
  const variable = ENV_KEYS[choice.id];
  return new Error(`No API key for ${choice.id}. Set ${variable ? `${variable} or run` : "one with"} \`oxbit-agent login --provider ${choice.id}\``);
}

/** The request URL under `base`. Throws for paths that leave it. */
export function requestUrl(base: string, path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /\.\.|\\|#|\s|%2e/i.test(path)) throw new Error(`The model API path ${path} is not allowed`);
  const url = new URL(base + path);
  const root = new URL(base);
  if (url.origin !== root.origin || !url.pathname.startsWith(`${root.pathname.replace(/\/$/, "")}/`)) throw new Error(`The model API path ${path} is not allowed`);
  return url;
}

type Fetch = typeof fetch;
export interface KeyStore {
  save(provider: string, key: string): Promise<void>;
  remove(provider: string): Promise<void>;
}

/** AgentModels over fetch for one provider: pinned to its base, no redirects, key in headers. */
export function nodeModels(choice: ProviderChoice, keys?: KeyStore, fetcher: Fetch = fetch): AgentModels {
  const matches = (endpoint: AgentModelEndpoint) => endpoint.api === choice.endpoint.api
    && (endpoint.api !== "openai-compatible" || normalizeBase(endpoint.baseUrl ?? "") === choice.base);
  return {
    async *stream(request: AgentModelRequest, signal?: AbortSignal) {
      if (!matches(request)) throw new Error("This model endpoint is not the configured provider");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (choice.endpoint.api === "anthropic") Object.assign(headers, { "x-api-key": choice.key ?? "", "anthropic-version": "2023-06-01" });
      else if (choice.key) headers.authorization = `Bearer ${choice.key}`;
      const response = await fetcher(requestUrl(choice.base, request.path), {
        method: request.method, headers, signal, redirect: "error",
        body: request.method === "POST" && request.body !== undefined ? JSON.stringify(request.body) : undefined,
      });
      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
        throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, body });
      }
      if (!response.body) return;
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let done = false;
      try {
        while (!done) {
          const chunk = await reader.read();
          done = chunk.done;
          const text = chunk.value ? decoder.decode(chunk.value, { stream: true }) : "";
          if (text) yield text;
        }
      } finally {
        if (!done) await reader.cancel().catch(() => {});
      }
      const rest = decoder.decode();
      if (rest) yield rest;
    },
    keys: {
      has: async (endpoint) => matches(endpoint) && (!needsKey(choice) || !!choice.key),
      save: async (endpoint, key) => {
        if (!matches(endpoint) || !keys) throw new Error("This endpoint is not the configured provider");
        await keys.save(choice.id, key);
        choice.key = key;
      },
      remove: async (endpoint) => {
        if (!matches(endpoint) || !keys) return;
        await keys.remove(choice.id);
        choice.key = undefined;
      },
    },
  };
}
