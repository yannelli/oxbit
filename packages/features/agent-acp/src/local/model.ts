import type { AgentModelApi, AgentModelEndpoint, AgentModelRequest, AgentModels } from "@oxbit/sdk";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text as the model produced it. */
  arguments: string;
}
export interface ToolResult {
  id: string;
  name: string;
  output: string;
  error?: boolean;
}
export type Turn =
  | { role: "user"; text: string }
  /** `native` holds the API's own output items so the same adapter can replay reasoning state. */
  | { role: "assistant"; text: string; calls: ToolCall[]; native?: { api: AgentModelApi; items: unknown[] } }
  | { role: "tool"; results: ToolResult[] };
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export type Effort = "low" | "medium" | "high";
export interface ModelInput {
  model: string;
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  effort?: Effort;
  maxTokens?: number;
}
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";
export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: ToolCall }
  /** Tokens of the last request: `input` includes cached tokens. */
  | { type: "usage"; input: number; output: number }
  | { type: "stop"; reason: StopReason; native?: unknown[] };
export interface ModelAdapter {
  request(input: ModelInput): Pick<AgentModelRequest, "method" | "path" | "body">;
  events(chunks: AsyncIterable<string>): AsyncIterable<ModelEvent>;
}
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
}

const count = (...values: unknown[]) => values.find((value): value is number => Number.isSafeInteger(value) && (value as number) > 0);

export async function readText(models: AgentModels, request: AgentModelRequest, signal?: AbortSignal) {
  let text = "";
  for await (const chunk of models.stream(request, signal)) text += chunk;
  return text;
}

/** `GET /v1/models` for OpenAI, Anthropic, and OpenAI-compatible lists such as OpenRouter's. */
export async function listModels(models: AgentModels, endpoint: AgentModelEndpoint, signal?: AbortSignal): Promise<ModelInfo[]> {
  const body = JSON.parse(await readText(models, { ...endpoint, method: "GET", path: "/v1/models" }, signal));
  if (!Array.isArray(body?.data)) throw new Error("The model list has no data array");
  return body.data
    .filter((item: any) => typeof item?.id === "string" && item.id)
    .slice(0, 1000)
    .map((item: any) => ({
      id: item.id,
      name: typeof item.display_name === "string" ? item.display_name : typeof item.name === "string" ? item.name : item.id,
      contextWindow: count(item.max_input_tokens, item.context_length),
      maxOutput: count(item.max_tokens, item.top_provider?.max_completion_tokens),
    }));
}

/** A readable error from a non-2xx model response. */
export function modelError(error: unknown) {
  const { status, body } = (error ?? {}) as { status?: unknown; body?: unknown };
  if (typeof status !== "number") return error instanceof Error ? error : new Error(String(error));
  let detail = typeof body === "string" ? body.trim().slice(0, 1000) : "";
  try {
    const parsed = JSON.parse(detail);
    detail = parsed?.error?.message ?? parsed?.message ?? detail;
  } catch {
    // The body is plain text.
  }
  return new Error(`Model API error ${status}${detail ? `: ${detail}` : ""}`);
}
