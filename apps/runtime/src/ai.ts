import { ADAPTERS, apiKeySlot, listModels, modelError, type Fetch, type ProviderId } from "@oxbit/agent-core";
import { FileAuthStore } from "@oxbit/agent/auth";
import { AgentConfig, agentHome } from "@oxbit/agent/config";
import { missingKey, normalizeBase, selectProvider } from "@oxbit/agent/providers";
import { RpcError } from "@oxbit/protocol";

const MAX_PROMPT_CHARS = 400_000;
const MAX_OUTPUT_TOKENS = 8192;

export interface AiCompletionOptions {
  /** The Oxbit agent home holding settings.json and auth.json; defaults to OXBIT_AGENT_HOME or ~/.oxbit/agent. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

const text = (params: Record<string, unknown>, key: string, limit: number, optional = false) => {
  const value = params[key];
  if (optional && (value === undefined || value === "")) return undefined;
  if (typeof value !== "string" || value.length > limit) throw new RpcError("INVALID_PARAMS", `Invalid ${key}`);
  return value;
};

/** Providers an editor request can name instead of the Oxbit agent's. */
const EDITOR_PROVIDERS = new Set<ProviderId>(["openrouter", "openai-compatible", "ollama"]);
const KEYED_PROVIDERS = new Set<ProviderId>(["openrouter", "openai-compatible"]);

function editorProvider(params: Record<string, unknown>, allowed = EDITOR_PROVIDERS) {
  const provider = text(params, "provider", 40, true) as ProviderId | undefined;
  if (provider && !allowed.has(provider)) throw new RpcError("INVALID_PARAMS", "Invalid provider");
  const baseUrl = text(params, "baseUrl", 2048, true);
  if (provider === "openai-compatible" && !baseUrl) throw new RpcError("INVALID_PARAMS", "Set AI base URL for the custom OpenAI API");
  return { provider, baseUrl };
}

/** One-shot model requests for editor AI features, sent with the Oxbit agent's provider, model and saved key, or with the provider the request names. */
export class AiCompletions {
  constructor(private options: AiCompletionOptions = {}) {}

  async complete(params: Record<string, unknown>, signal?: AbortSignal) {
    const system = text(params, "system", 20_000)!;
    const prompt = text(params, "prompt", MAX_PROMPT_CHARS)!;
    const requested = text(params, "model", 200, true);
    const effort = text(params, "effort", 32, true);
    const maxTokens = params.maxTokens;
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > MAX_OUTPUT_TOKENS))
      throw new RpcError("INVALID_PARAMS", "Invalid maxTokens");
    const { provider, baseUrl } = editorProvider(params);
    if (provider && !requested) throw new RpcError("INVALID_PARAMS", "Set AI model for this provider");
    const choice = await this.choose(provider, baseUrl);
    const model = requested ?? choice.model;
    if (!model) throw new RpcError("UNAVAILABLE", "Set ai.model, or a model for the Oxbit agent");
    const endpoint = choice.runtime.endpoint();
    const adapter = ADAPTERS[endpoint.api];
    const request = adapter.request({ model, system, turns: [{ role: "user", text: prompt }], tools: [],
      ...(effort ? { effort } : {}), ...(maxTokens ? { maxTokens: maxTokens as number } : {}) });
    let output = "";
    try {
      for await (const event of adapter.events(choice.runtime.models().stream({ ...endpoint, ...request }, signal)))
        if (event.type === "text") output += event.text;
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RpcError("MODEL_ERROR", modelError(error).message);
    }
    return { text: output, model };
  }

  /** Model IDs the named provider lists, for the Settings suggestions of a local model server. */
  async models(params: Record<string, unknown>, signal?: AbortSignal) {
    const { provider, baseUrl } = editorProvider(params);
    if (!provider) throw new RpcError("INVALID_PARAMS", "Invalid provider");
    const choice = await this.choose(provider, baseUrl);
    try {
      return { models: (await listModels(choice.runtime.models(), choice.runtime.endpoint(), signal)).slice(0, 200).map((model) => model.id) };
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RpcError("MODEL_ERROR", modelError(error).message);
    }
  }

  /** The Oxbit agent's provider, or `provider` with `baseUrl` laid over the agent's settings so its saved key and method apply. */
  private async choose(provider?: ProviderId, baseUrl?: string) {
    const env = this.options.env ?? process.env;
    const config = await AgentConfig.load(this.options.home ?? agentHome(env));
    const settings = provider ? {
      ...config.settings, provider,
      providers: { ...config.settings.providers, [provider]: { ...config.settings.providers?.[provider], ...(baseUrl ? { baseUrl } : {}) } },
    } : config.settings;
    let choice;
    try {
      choice = await selectProvider({ provider, settings, env, auth: new FileAuthStore(config.paths.auth), fetch: this.options.fetch });
    } catch (error) {
      throw new RpcError("UNAVAILABLE", (error as Error).message);
    }
    if (!choice.ready) throw new RpcError("UNAVAILABLE", provider ? "Run Set AI Provider API Key to add a key for this provider" : missingKey(choice).message);
    return choice;
  }

  /** Checks, saves or removes the auth.json key that `complete` uses for an OpenRouter or custom OpenAI API request. */
  async key(params: Record<string, unknown>) {
    const operation = params.operation;
    if (operation !== "has" && operation !== "save" && operation !== "remove") throw new RpcError("INVALID_PARAMS", "Invalid operation");
    const { provider, baseUrl } = editorProvider(params, KEYED_PROVIDERS);
    if (!provider) throw new RpcError("INVALID_PARAMS", "Invalid provider");
    let slot: string;
    try {
      slot = apiKeySlot(provider, provider === "openai-compatible" ? normalizeBase(baseUrl!) : undefined);
    } catch (error) {
      throw new RpcError("INVALID_PARAMS", (error as Error).message);
    }
    const env = this.options.env ?? process.env;
    const auth = new FileAuthStore((await AgentConfig.load(this.options.home ?? agentHome(env))).paths.auth);
    if (operation === "has") return { saved: !!(await auth.get(slot)) || (provider === "openrouter" && !!env.OPENROUTER_API_KEY) };
    if (operation === "remove") {
      await auth.delete(slot);
      return {};
    }
    const key = text(params, "key", 4096)!.trim();
    if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new RpcError("INVALID_PARAMS", "Enter the API key as printed, without spaces");
    await auth.set(slot, key);
    return {};
  }
}
