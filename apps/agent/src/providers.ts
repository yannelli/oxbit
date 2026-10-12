import {
  PROVIDERS, apiKeySlot, provider as providerRuntime, providerSpec,
  type AuthMethod, type AuthStore, type CatalogCache, type Fetch, type ProviderId, type ProviderRuntime, type ProviderSpec,
} from "@oxbit/agent-core";
import { CLAUDE_PLAN } from "./claude.js";
import { stringList, type AgentSettings } from "./config.js";

export const PROVIDER_IDS = [...PROVIDERS.map((spec) => spec.id), CLAUDE_PLAN.id];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const OLLAMA = "http://127.0.0.1:11434";
/** Providers picked by a saved or environment key when settings name none, in this order. */
const DETECTED: ProviderId[] = ["anthropic", "openai", "openrouter"];

export interface ProviderChoice {
  id: ProviderId;
  runtime: ProviderRuntime;
  /** The model from --model or settings for this provider. */
  model?: string;
  /** Whether the key, ChatGPT sign-in or keyless method was usable at startup. */
  ready: boolean;
}
/** The Claude plan, which replaces the Oxbit agent with Claude Agent. */
export interface ClaudeChoice {
  id: typeof CLAUDE_PLAN.id;
  model?: string;
}
export type ActiveProvider = ProviderChoice | ClaudeChoice;
export const isClaude = (choice: ActiveProvider): choice is ClaudeChoice => choice.id === CLAUDE_PLAN.id;
export interface ProviderInput {
  provider?: string;
  model?: string;
  /** Overrides settings and detection, for `login --provider`. */
  method?: AuthMethod;
  settings: AgentSettings;
  env: Record<string, string | undefined>;
  auth: AuthStore;
  fetch?: Fetch;
  cache?: CatalogCache;
}

/** https, or http on a loopback host. Adds http:// when the scheme is missing and drops a trailing /v1, since the adapters send /v1/... paths. */
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

/** Whether auth.json holds an active ChatGPT sign-in. Reads the entry without creating it. */
export async function chatgptSignedIn(auth: AuthStore) {
  try {
    const record = JSON.parse((await auth.get("chatgpt")) ?? "null");
    return Array.isArray(record?.accounts) && record.accounts.some((account: any) => account?.client_id === record.active && !!account.refresh_token);
  } catch {
    return false;
  }
}

const keyFor = async (spec: ProviderSpec, input: ProviderInput, baseUrl?: string) =>
  !!((await input.auth.get(apiKeySlot(spec.id, baseUrl))) || (spec.env && input.env[spec.env]));

function baseFor(spec: ProviderSpec, settings: AgentSettings, env: ProviderInput["env"]) {
  const own = settings.providers?.[spec.id]?.baseUrl;
  const configured = spec.id === "ollama" ? own || env.OLLAMA_HOST || OLLAMA
    : spec.id === "openai-compatible" ? own || env.OXBIT_AGENT_BASE_URL : spec.id === "openrouter" ? own : undefined;
  if (spec.id === "openai-compatible" && !configured) throw new Error("Set providers[\"openai-compatible\"].baseUrl in settings.json or OXBIT_AGENT_BASE_URL");
  return configured ? normalizeBase(configured) : undefined;
}

/** settings.json `method`, else ChatGPT when signed in, else an API key when one exists or is the only method, else no key where allowed. */
async function methodFor(spec: ProviderSpec, input: ProviderInput, signedIn: boolean, baseUrl?: string): Promise<AuthMethod> {
  const ids = spec.methods.map((method) => method.id);
  const configured = input.method ?? input.settings.providers?.[spec.id]?.method;
  if (configured) {
    if (!ids.includes(configured as AuthMethod)) throw new Error(`${spec.name} does not support the ${configured} method. Use one of: ${ids.join(", ")}`);
    return configured as AuthMethod;
  }
  if (ids.includes("chatgpt") && signedIn) return "chatgpt";
  if (ids.includes("api-key") && (ids.length === 1 || await keyFor(spec, input, baseUrl))) return "api-key";
  return ids.includes("none") ? "none" : ids.find((id) => id !== "chatgpt") ?? ids[0];
}

/** The Claude plan when --provider or settings.json names it, else selectProvider. */
export async function activeProvider(input: ProviderInput): Promise<ActiveProvider> {
  if ((input.provider || input.settings.provider) !== CLAUDE_PLAN.id) return selectProvider(input);
  const model = input.model || input.settings.providers?.[CLAUDE_PLAN.id]?.model;
  return { id: CLAUDE_PLAN.id, ...model ? { model } : {} };
}

/** Provider from --provider, settings.json, then a saved or environment key outside `disabledProviders`, then Ollama; model from --model, then settings. */
export async function selectProvider(input: ProviderInput): Promise<ProviderChoice> {
  const { settings, env } = input;
  const signedIn = await chatgptSignedIn(input.auth);
  let detected: ProviderId | undefined;
  const disabled = stringList(settings.disabledProviders);
  if (!input.provider && !settings.provider)
    for (const id of DETECTED) {
      if (disabled.includes(id)) continue;
      if (await keyFor(providerSpec(id)!, input) || (id === "openai" && signedIn)) {
        detected = id;
        break;
      }
    }
  const name = input.provider || settings.provider || detected || "ollama";
  const spec = providerSpec(name);
  if (name === CLAUDE_PLAN.id) throw new Error(`${CLAUDE_PLAN.name} runs Claude Agent and has no model provider settings`);
  if (!spec) throw new Error(`Unknown provider ${name}. Use one of: ${PROVIDER_IDS.join(", ")}`);
  const baseUrl = baseFor(spec, settings, env);
  const method = await methodFor(spec, input, signedIn, baseUrl);
  const runtime = providerRuntime({ provider: spec.id, method, ...baseUrl ? { baseUrl } : {} },
    { fetch: input.fetch ?? ((url, init) => fetch(url, init)), auth: input.auth, env, cache: input.cache });
  const ready = method === "chatgpt" ? signedIn : await runtime.models().keys.has(runtime.endpoint());
  const own = settings.providers?.[spec.id]?.model;
  const saved = own || (settings.provider === spec.id || !settings.provider ? settings.model : undefined);
  return { id: spec.id, runtime, model: input.model || saved || undefined, ready };
}

export function missingKey(choice: ProviderChoice) {
  const { spec, method } = choice.runtime;
  if (method === "chatgpt") return new Error("Sign in with ChatGPT first: oxbit-agent login chatgpt");
  const plan = spec.methods.some((item) => item.id === "chatgpt") ? ", or use your ChatGPT plan: oxbit-agent login chatgpt" : "";
  return new Error(`No API key for ${spec.id}. Set ${spec.env ? `${spec.env} or run` : "one with"} \`oxbit-agent login --provider ${spec.id}\`${plan}`);
}
