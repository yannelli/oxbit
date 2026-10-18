import { ADAPTERS, modelError, type Fetch } from "@oxbit/agent-core";
import { FileAuthStore } from "@oxbit/agent/auth";
import { AgentConfig, agentHome } from "@oxbit/agent/config";
import { missingKey, selectProvider } from "@oxbit/agent/providers";
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

/** One-shot model requests for editor AI features, sent with the Oxbit agent's provider, model and saved key. */
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
    const env = this.options.env ?? process.env;
    const config = await AgentConfig.load(this.options.home ?? agentHome(env));
    let choice;
    try {
      choice = await selectProvider({ settings: config.settings, env, auth: new FileAuthStore(config.paths.auth), fetch: this.options.fetch });
    } catch (error) {
      throw new RpcError("UNAVAILABLE", (error as Error).message);
    }
    if (!choice.ready) throw new RpcError("UNAVAILABLE", missingKey(choice).message);
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
}
