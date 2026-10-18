import { ADAPTERS } from "@oxbit/agent-core";
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

export interface AiRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}
/** One-shot model requests for editor features. Registered under AI_SERVICE. */
export interface AiService {
  complete(request: AiRequest, signal?: AbortSignal): Promise<string>;
}

function agentEndpoint(kernel: Kernel): AgentModelEndpoint {
  const api = kernel.configuration.get<AgentModelApi>(OXBIT_AGENT_SETTINGS.api) || "openai";
  return api === "openai-compatible" ? { api, baseUrl: kernel.configuration.get<string>(OXBIT_AGENT_SETTINGS.baseUrl)?.trim() ?? "" } : { api };
}

/** Uses the host's AGENT_MODELS_SERVICE when it holds a key (iOS), else the runtime's `ai.complete`, which sends with the Oxbit agent's provider and key. */
export function createAiService(kernel: Kernel, runtime?: RpcClient): AiService {
  const setting = (id: string) => kernel.configuration.get<string>(id)?.trim() || undefined;
  async function local(models: AgentModels, request: AiRequest, signal?: AbortSignal) {
    const endpoint = agentEndpoint(kernel);
    const model = setting(AI_SETTINGS.model) ?? setting(OXBIT_AGENT_SETTINGS.model);
    if (!model) throw new Error("Set ai.model, or a model in Agent setup");
    const adapter = ADAPTERS[endpoint.api];
    const effort = setting(AI_SETTINGS.effort);
    const body = adapter.request({ model, system: request.system, turns: [{ role: "user", text: request.prompt }], tools: [],
      ...(effort ? { effort } : {}), ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}) });
    let text = "";
    for await (const event of adapter.events(models.stream({ ...endpoint, ...body }, signal)))
      if (event.type === "text") text += event.text;
    return text;
  }
  return {
    async complete(request, signal) {
      const models = kernel.services.optional<AgentModels>(AGENT_MODELS_SERVICE);
      if (models && (!runtime?.connected || await models.keys.has(agentEndpoint(kernel))))
        return local(models, request, signal);
      if (!runtime?.connected) throw new Error(AI_UNAVAILABLE);
      const model = setting(AI_SETTINGS.model), effort = setting(AI_SETTINGS.effort);
      const result = await runtime.request<{ text: string }>("ai.complete",
        { ...request, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, { signal });
      return result.text;
    },
  };
}
