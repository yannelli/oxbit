import {
  MISSING_AGENT_KEY,
  OXBIT_AGENT_PROVIDER,
  type AgentModels,
  type FeatureOptions,
  type RpcClient,
  type Unsubscribe,
} from "@oxbit/sdk";
import { oxbitEndpoint } from "../configuration.js";

/** Placeholder for the in-app Oxbit agent runtime. It checks the API key on `acp.start` and rejects every method. */
export class LocalAgentRuntime implements RpcClient {
  readonly local = true;
  constructor(
    private options: FeatureOptions,
    private models: () => AgentModels | undefined,
  ) {}
  get connected() {
    return !!this.models();
  }
  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    _options?: { signal?: AbortSignal; id?: string },
  ): Promise<T> {
    const models = this.models();
    if (method === "acp.start" && params.provider === OXBIT_AGENT_PROVIDER && models &&
        !(await models.keys.has(oxbitEndpoint(this.options.kernel.configuration))))
      throw new Error(MISSING_AGENT_KEY);
    throw new Error(`${method} needs a runtime workspace`);
  }
  subscribe(_event: string, _listener: (params: any) => void): Unsubscribe {
    return () => {};
  }
}
