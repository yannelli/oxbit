import { listModels } from "@oxbit/agent-core";
import {
  AGENT_MODELS_SERVICE,
  OXBIT_AGENT_SETTINGS,
  type AgentModels,
  type Kernel,
  type RpcClient,
  type SettingSuggestion,
  type SettingSuggestions,
} from "@oxbit/sdk";
import { AI_SETTINGS } from "./configuration.js";
import { INLINE_MODELS, type InlineModelCatalog } from "./models.js";
import { OPENROUTER_BASE_URL, RUNTIME_PROVIDERS, aiEndpoint, aiProvider } from "./service.js";

const MAX_SUGGESTIONS = 12;

function catalogFor(kernel: Kernel): InlineModelCatalog | undefined {
  const provider = aiProvider(kernel);
  if (provider === "openrouter" || provider === "local") return provider;
  if (provider !== "agent") return undefined;
  const api = kernel.configuration.get<string>(OXBIT_AGENT_SETTINGS.api) || "openai";
  if (api === "openai" || api === "chatgpt") return "openai";
  if (api === "anthropic") return "anthropic";
  const base = kernel.configuration.get<string>(OXBIT_AGENT_SETTINGS.baseUrl)?.trim().replace(/\/+$/, "");
  return base === OPENROUTER_BASE_URL ? "openrouter" : undefined;
}

/** Model IDs a local or custom server lists, through the iOS host's model service or the runtime. */
async function served(kernel: Kernel, runtime: RpcClient | undefined, signal?: AbortSignal): Promise<string[]> {
  const provider = aiProvider(kernel);
  if (provider !== "local" && provider !== "openai-compatible") return [];
  const endpoint = aiEndpoint(kernel, provider);
  const models = kernel.services.optional<AgentModels>(AGENT_MODELS_SERVICE);
  if (models) {
    if (provider !== "local" && !await models.keys.has(endpoint)) return [];
    return (await listModels(models, endpoint, signal)).map((model) => model.id);
  }
  if (!runtime?.connected) return [];
  const result = await runtime.request<{ models: string[] }>("ai.models",
    { provider: RUNTIME_PROVIDERS[provider], baseUrl: endpoint.baseUrl }, { signal });
  return result.models;
}

/** Suggestions for ai.model: recommended inline completion models for the active provider, then the models a local or custom server lists. */
export function modelSuggestions(kernel: Kernel, runtime?: RpcClient): SettingSuggestions {
  return {
    setting: AI_SETTINGS.model,
    key: () => [AI_SETTINGS.provider, AI_SETTINGS.baseUrl, OXBIT_AGENT_SETTINGS.api, OXBIT_AGENT_SETTINGS.baseUrl]
      .map((id) => kernel.configuration.get<string>(id) ?? "").join("\n"),
    async list(signal) {
      const catalog = catalogFor(kernel);
      const recommended = catalog ? INLINE_MODELS[catalog] : [];
      let listed: string[] = [];
      try {
        listed = await served(kernel, runtime, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      const installed = new Set(listed);
      const suggestions: SettingSuggestion[] = recommended.map((model) => ({
        value: model.id, label: model.label,
        detail: [catalog === "local" && installed.has(model.id) ? "installed" : "", model.detail].filter(Boolean).join(" · "),
      }));
      for (const id of listed)
        if (!suggestions.some((item) => item.value === id))
          suggestions.push({ value: id, label: id, ...(catalog === "local" ? { detail: "installed" } : {}) });
      return suggestions.slice(0, MAX_SUGGESTIONS);
    },
  };
}
