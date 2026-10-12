import type { AgentModelApi, AgentModelEndpoint, AgentModels } from "@oxbit/sdk";
import { listModels, readText, type ModelInfo } from "../model.js";
import { BUILTIN_MODELS, fillLimits, modelsDevIndex, type CatalogCache, type ModelsDevIndex } from "./catalog.js";
import { ChatGPTAuth } from "./chatgpt.js";
import type { AuthStore, Fetch } from "./http.js";
import { endpointBase, httpModels } from "./models.js";
import { CHATGPT_LABELS, describePlanError } from "./siwc.js";

export type ProviderId = "openai" | "anthropic" | "openrouter" | "ollama" | "openai-compatible";
export type AuthMethod = "api-key" | "chatgpt" | "none";
export interface ProviderSpec {
  id: ProviderId;
  name: string;
  api: AgentModelApi;
  baseUrl?: string;
  methods: { id: AuthMethod; label: string; detail?: string }[];
  /** Environment variable read when no key is saved. */
  env?: string;
  /** models.dev provider ID for context windows. */
  modelsDev?: string;
  builtin?: "openai" | "anthropic";
}

export const PROVIDERS: readonly ProviderSpec[] = [
  { id: "openai", name: "OpenAI", api: "openai", env: "OPENAI_API_KEY", modelsDev: "openai", builtin: "openai", methods: [
    { id: "chatgpt", label: CHATGPT_LABELS.signIn, detail: "Use your ChatGPT plan" },
    { id: "api-key", label: "OpenAI API key" },
  ] },
  { id: "anthropic", name: "Anthropic", api: "anthropic", env: "ANTHROPIC_API_KEY", modelsDev: "anthropic", builtin: "anthropic", methods: [
    { id: "api-key", label: "Anthropic API key", detail: "Claude Max and Team monthly API credits are spent through a Claude Console API key." },
  ] },
  { id: "openrouter", name: "OpenRouter", api: "openai-compatible", baseUrl: "https://openrouter.ai/api", env: "OPENROUTER_API_KEY", modelsDev: "openrouter",
    methods: [{ id: "api-key", label: "OpenRouter API key" }] },
  { id: "ollama", name: "Ollama", api: "openai-compatible", baseUrl: "http://localhost:11434", methods: [{ id: "none", label: "Local Ollama, no key" }] },
  { id: "openai-compatible", name: "OpenAI-compatible", api: "openai-compatible", methods: [{ id: "api-key", label: "API key" }, { id: "none", label: "No key" }] },
];

export interface ProviderSelection {
  provider: ProviderId;
  /** Defaults to the provider's first method. */
  method?: AuthMethod;
  /** Required for openai-compatible; overrides the Ollama and OpenRouter defaults. */
  baseUrl?: string;
  /** models.dev provider ID for an openai-compatible server. */
  modelsDev?: string;
}

export interface ProviderHost {
  fetch: Fetch;
  auth: AuthStore;
  env?: Record<string, string | undefined>;
  cache?: CatalogCache;
  now?(): number;
  /** Shared sign-in state; one is created over `auth` when absent. */
  chatgpt?: ChatGPTAuth;
}

/** What an AgentHost needs for the selected provider. */
export interface ProviderRuntime {
  spec: ProviderSpec;
  method: AuthMethod;
  /** "Using ChatGPT plan" for plan requests, else the provider name. */
  label: string;
  chatgpt?: ChatGPTAuth;
  endpoint(): AgentModelEndpoint;
  models(): AgentModels;
  catalog(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export const providerSpec = (id: string) => PROVIDERS.find((spec) => spec.id === id);
/** The AuthStore key for a provider's API key; openai-compatible keys are per origin. */
export const apiKeySlot = (provider: ProviderId, baseUrl?: string) =>
  provider === "openai-compatible" ? `apikey:openai-compatible ${new URL(baseUrl ?? "").origin}` : `apikey:${provider}`;

/** Parses the `{models: [{slug, display_name, visibility, context_window}]}` list that a ChatGPT plan token gets from GET /v1/models. */
export function planModels(body: any): ModelInfo[] {
  if (!Array.isArray(body?.models)) throw new Error("The ChatGPT model list has no models array");
  return body.models
    .filter((model: any) => typeof model?.slug === "string" && model.slug && model.visibility === "list" && model.supported_in_api !== false)
    .map((model: any) => ({ id: model.slug, name: typeof model.display_name === "string" ? model.display_name : model.slug,
      ...(Number.isSafeInteger(model.context_window) && model.context_window > 0 ? { contextWindow: model.context_window } : {}) }));
}

export function provider(selection: ProviderSelection, host: ProviderHost): ProviderRuntime {
  const spec = providerSpec(selection.provider);
  if (!spec) throw new Error(`Unknown provider ${selection.provider}`);
  const method = selection.method ?? spec.methods[0].id;
  if (!spec.methods.some((item) => item.id === method)) throw new Error(`${spec.name} does not support ${method} sign-in`);
  const baseUrl = selection.baseUrl ?? spec.baseUrl;
  if (spec.api === "openai-compatible" && !baseUrl) throw new Error(`Set a base URL for ${spec.name}`);
  const endpoint: AgentModelEndpoint = spec.api === "openai-compatible" ? { api: spec.api, baseUrl } : { api: spec.api };
  const loopbackHttp = spec.api === "openai-compatible";
  endpointBase(endpoint, loopbackHttp);
  const chatgpt = method === "chatgpt" ? host.chatgpt ?? new ChatGPTAuth({ fetch: host.fetch, store: host.auth, now: host.now }) : undefined;
  const slot = method === "api-key" ? apiKeySlot(spec.id, baseUrl) : undefined;
  const key = async () => slot ? (await host.auth.get(slot)) ?? (spec.env ? host.env?.[spec.env] : undefined) : undefined;
  const models = httpModels({
    fetch: host.fetch, loopbackHttp,
    credentials: chatgpt ? { get: () => chatgpt.accessToken(), refresh: () => chatgpt.accessToken(true) } : { get: key },
    keys: {
      has: async () => chatgpt ? !!(await chatgpt.account())?.access_token : method === "none" || !!(await key()),
      save: async (_endpoint, value) => {
        if (!slot) throw new Error(`${spec.name} with ${method} does not use an API key`);
        await host.auth.set(slot, value);
      },
      remove: async () => {
        if (slot) await host.auth.delete(slot);
      },
    },
    ...(chatgpt ? { describe: describePlanError } : {}),
  });
  let index: Promise<ModelsDevIndex | undefined> | undefined;
  const modelsDev = selection.modelsDev ?? spec.modelsDev;
  const sources = { builtin: spec.builtin, modelsDev,
    index: (signal?: AbortSignal) => index ??= modelsDevIndex({ fetch: host.fetch, cache: host.cache, now: host.now }, signal) };
  return {
    spec, method, chatgpt, label: chatgpt ? CHATGPT_LABELS.inUse : spec.name,
    endpoint: () => endpoint,
    models: () => models,
    async catalog(signal) {
      let listed: ModelInfo[];
      try {
        listed = chatgpt ? planModels(JSON.parse(await readText(models, { ...endpoint, method: "GET", path: "/v1/models" }, signal)))
          : await listModels(models, endpoint, signal);
      } catch (error) {
        if (!spec.builtin || chatgpt) throw error;
        listed = BUILTIN_MODELS[spec.builtin].map((model) => ({ ...model }));
      }
      return fillLimits(listed, sources, signal);
    },
  };
}
