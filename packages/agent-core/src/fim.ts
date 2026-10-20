import type { AgentModelEndpoint, AgentModels } from "@oxbit/sdk";

export interface FimRequest {
  model: string;
  prefix: string;
  suffix: string;
  maxTokens?: number;
}

const unsupported = new Set<string>();
const key = (endpoint: AgentModelEndpoint, model: string) => `${endpoint.baseUrl ?? endpoint.api} ${model}`;

/** Whether a fill-in-the-middle request to this model may work; false once the server rejected one. */
export function fimAvailable(endpoint: AgentModelEndpoint, model: string) {
  return endpoint.api === "openai-compatible" && !unsupported.has(key(endpoint, model));
}

/** Ollama answers 400 "does not support insert" for models whose template has no suffix; other servers answer 404 or 501. */
function rejectsFim(error: unknown) {
  const status = (error as { status?: number }).status;
  return status === 404 || status === 405 || status === 501 || (status === 400 || status === 422) && /insert|suffix|fim|not support/i.test(String((error as { body?: string }).body ?? ""));
}

/** Sends `prefix` as `prompt` and `suffix` to `/v1/completions`. Resolves to undefined, and remembers it, when the server or model has no FIM support. */
export async function fimComplete(models: AgentModels, endpoint: AgentModelEndpoint, request: FimRequest, signal?: AbortSignal): Promise<string | undefined> {
  const body = {
    model: request.model, prompt: request.prefix, suffix: request.suffix, temperature: 0.2, stream: false,
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
  };
  let text = "";
  try {
    for await (const chunk of models.stream({ ...endpoint, method: "POST", path: "/v1/completions", body }, signal)) text += chunk;
  } catch (error) {
    if (signal?.aborted || !rejectsFim(error)) throw error;
    unsupported.add(key(endpoint, request.model));
    return undefined;
  }
  const reply = JSON.parse(text) as { choices?: { text?: unknown }[] };
  const choice = reply.choices?.[0]?.text;
  return typeof choice === "string" ? choice : "";
}
