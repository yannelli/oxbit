import { ADAPTERS, fimAvailable, fimComplete, providerSpec, withOutputLimit } from "@oxbit/agent-core";
import {
  AGENT_MODELS_SERVICE,
  OXBIT_AGENT_SETTINGS,
  type AgentModelApi,
  type AgentModelEndpoint,
  type AgentModels,
  type Kernel,
  type RpcClient,
} from "@oxbit/sdk";
import { AI_SETTINGS } from "./configuration.js";

export const AI_SERVICE = "ai";
export const AI_UNAVAILABLE = "AI editor features need a runtime connection or an API key in Agent setup";

export type AiProvider = "agent" | "openrouter" | "openai-compatible" | "local";
export const AI_PROVIDER_NAMES: Record<AiProvider, string> = {
  agent: "the Oxbit agent", openrouter: "OpenRouter", "openai-compatible": "the custom OpenAI API", local: "the local model server",
};
/** Provider IDs the runtime's `ai.complete` and `ai.key` accept for each non-agent provider. */
export const RUNTIME_PROVIDERS = { openrouter: "openrouter", "openai-compatible": "openai-compatible", local: "ollama" } as const;
export const OPENROUTER_BASE_URL = providerSpec("openrouter")!.baseUrl!;
export const LOCAL_BASE_URL = providerSpec("ollama")!.baseUrl!;

export interface AiRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** The code around the cursor for a fill-in-the-middle request; the local provider tries it before the chat prompt. */
  fim?: { prefix: string; suffix: string };
}
/** One-shot model requests for editor features. Registered under AI_SERVICE. */
export interface AiService {
  complete(request: AiRequest, signal?: AbortSignal): Promise<string>;
  /** Resolves `undefined` when `complete` would reach a model, else the setup message `complete` throws. Sends no model request. */
  available(signal?: AbortSignal): Promise<string | undefined>;
}

function agentEndpoint(kernel: Kernel): AgentModelEndpoint {
  const api = kernel.configuration.get<AgentModelApi>(OXBIT_AGENT_SETTINGS.api) || "openai";
  return api === "openai-compatible" ? { api, baseUrl: kernel.configuration.get<string>(OXBIT_AGENT_SETTINGS.baseUrl)?.trim() ?? "" } : { api };
}

export function aiProvider(kernel: Kernel): AiProvider {
  const value = kernel.configuration.get<string>(AI_SETTINGS.provider);
  return value === "openrouter" || value === "openai-compatible" || value === "local" ? value : "agent";
}

/** The endpoint for a non-agent provider, shaped like Agent setup's so both share a saved key. */
export function aiEndpoint(kernel: Kernel, provider: Exclude<AiProvider, "agent">): AgentModelEndpoint {
  const baseUrl = kernel.configuration.get<string>(AI_SETTINGS.baseUrl)?.trim() ?? "";
  if (provider === "openrouter") return { api: "openai-compatible", baseUrl: OPENROUTER_BASE_URL };
  if (provider === "local") return { api: "openai-compatible", baseUrl: baseUrl || LOCAL_BASE_URL };
  if (!baseUrl) throw new Error("Set AI base URL to the custom OpenAI API, for example https://api.example.com");
  return { api: "openai-compatible", baseUrl };
}

const NO_AGENT_MODEL = "Set ai.model, or a model in Agent setup";
const noModel = (provider: Exclude<AiProvider, "agent">) => `Set AI model to a model on ${AI_PROVIDER_NAMES[provider]}`;
const noKey = (provider: Exclude<AiProvider, "agent">) => `Run Set AI Provider API Key to add a key for ${AI_PROVIDER_NAMES[provider]}`;
const runtimeTarget = (provider: Exclude<AiProvider, "agent">, endpoint: AgentModelEndpoint, model: string) =>
  ({ model, provider: RUNTIME_PROVIDERS[provider], ...(provider === "openrouter" ? {} : { baseUrl: endpoint.baseUrl }) });

/** Uses the host's AGENT_MODELS_SERVICE (iOS) when it holds the key, else the runtime's `ai.complete`, which reads keys from the agent's auth.json. */
export function createAiService(kernel: Kernel, runtime?: RpcClient): AiService {
  const setting = (id: string) => kernel.configuration.get<string>(id)?.trim() || undefined;
  async function local(models: AgentModels, endpoint: AgentModelEndpoint, model: string, request: AiRequest, signal?: AbortSignal) {
    const adapter = ADAPTERS[endpoint.api];
    const effort = setting(AI_SETTINGS.effort);
    const body = withOutputLimit(endpoint.api, adapter.request({ model, system: request.system, turns: [{ role: "user", text: request.prompt }], tools: [],
      ...(effort ? { effort } : {}), ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}) }), request.maxTokens);
    let text = "";
    for await (const event of adapter.events(models.stream({ ...endpoint, ...body }, signal)))
      if (event.type === "text") text += event.text;
    return text;
  }
  async function viaProvider(provider: Exclude<AiProvider, "agent">, request: AiRequest, signal?: AbortSignal) {
    const endpoint = aiEndpoint(kernel, provider), model = setting(AI_SETTINGS.model);
    if (!model) throw new Error(noModel(provider));
    const models = kernel.services.optional<AgentModels>(AGENT_MODELS_SERVICE);
    if (models) {
      if (provider !== "local" && !await models.keys.has(endpoint)) throw new Error(noKey(provider));
      if (provider === "local" && request.fim && fimAvailable(endpoint, model)) {
        const text = await fimComplete(models, endpoint, { model, ...request.fim, maxTokens: request.maxTokens }, signal);
        if (text !== undefined) return text;
      }
      return local(models, endpoint, model, request, signal);
    }
    if (!runtime?.connected) throw new Error(AI_UNAVAILABLE);
    const effort = setting(AI_SETTINGS.effort);
    const { fim, ...chat } = request;
    const result = await runtime.request<{ text: string }>("ai.complete", {
      ...chat, ...(provider === "local" && fim ? { fim } : {}), ...runtimeTarget(provider, endpoint, model), ...(effort ? { effort } : {}),
    }, { signal });
    return result.text;
  }
  async function runtimeStatus(params: Record<string, unknown>, signal?: AbortSignal) {
    try {
      await runtime!.request<{ model: string }>("ai.status", params, { signal });
      return undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      if ((error as { code?: unknown } | null)?.code === "METHOD_NOT_FOUND") return undefined;
      return error instanceof Error ? error.message : String(error);
    }
  }
  async function providerAvailable(provider: Exclude<AiProvider, "agent">, signal?: AbortSignal) {
    let endpoint: AgentModelEndpoint;
    try {
      endpoint = aiEndpoint(kernel, provider);
    } catch (error) {
      return (error as Error).message;
    }
    const model = setting(AI_SETTINGS.model);
    if (!model) return noModel(provider);
    const models = kernel.services.optional<AgentModels>(AGENT_MODELS_SERVICE);
    if (models) return provider !== "local" && !await models.keys.has(endpoint) ? noKey(provider) : undefined;
    if (!runtime?.connected) return AI_UNAVAILABLE;
    return runtimeStatus(runtimeTarget(provider, endpoint, model), signal);
  }
  return {
    async complete(request, signal) {
      const provider = aiProvider(kernel);
      if (provider !== "agent") return viaProvider(provider, request, signal);
      const models = kernel.services.optional<AgentModels>(AGENT_MODELS_SERVICE);
      if (models && (!runtime?.connected || await models.keys.has(agentEndpoint(kernel)))) {
        const model = setting(AI_SETTINGS.model) ?? setting(OXBIT_AGENT_SETTINGS.model);
        if (!model) throw new Error(NO_AGENT_MODEL);
        return local(models, agentEndpoint(kernel), model, request, signal);
      }
      if (!runtime?.connected) throw new Error(AI_UNAVAILABLE);
      const model = setting(AI_SETTINGS.model), effort = setting(AI_SETTINGS.effort);
      const result = await runtime.request<{ text: string }>("ai.complete",
        { ...request, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, { signal });
      return result.text;
    },
    async available(signal) {
      const provider = aiProvider(kernel);
      if (provider !== "agent") return providerAvailable(provider, signal);
      const models = kernel.services.optional<AgentModels>(AGENT_MODELS_SERVICE);
      if (models && (!runtime?.connected || await models.keys.has(agentEndpoint(kernel))))
        return (setting(AI_SETTINGS.model) ?? setting(OXBIT_AGENT_SETTINGS.model)) ? undefined : NO_AGENT_MODEL;
      if (!runtime?.connected) return AI_UNAVAILABLE;
      const model = setting(AI_SETTINGS.model);
      return runtimeStatus(model ? { model } : {}, signal);
    },
  };
}
