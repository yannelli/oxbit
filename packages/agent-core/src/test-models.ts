import type { AgentModelApi, AgentModelEndpoint, AgentModelRequest, AgentModels } from "@oxbit/sdk";

/** Test doubles for the host's AgentModels service and the Oxbit agent settings. */
export type Reply = string[] | ((signal?: AbortSignal) => AsyncIterable<string>);
export async function* chunks(items: string[]) {
  yield* items;
}
/** Splits text into chunks of `size` characters to exercise lines split across reads. */
export const split = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
export const sse = (...events: unknown[]) => [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"];
export const chatText = (text: string) => sse(
  { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
);
export const chatTool = (id: string, name: string, args: unknown) => sse(
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
);
/** Streams `first`, then waits until the request is aborted. */
export const hanging = (first: string[] = []) => async function* (signal?: AbortSignal) {
  yield* first;
  await new Promise((_, reject) => signal?.aborted ? reject(new Error("aborted")) : signal?.addEventListener("abort", () => reject(new Error("aborted"))));
};

export function fakeModels(replies: Reply[], options: { key?: boolean; list?: unknown } = {}) {
  const requests: AgentModelRequest[] = [];
  const models: AgentModels = {
    stream(request, signal) {
      requests.push(structuredClone(request));
      if (request.method === "GET")
        return chunks([JSON.stringify(options.list ?? { data: [{ id: "model-a", context_length: 1000 }, { id: "model-b" }] })]);
      const reply = replies.shift();
      if (!reply) throw new Error("No scripted model reply");
      return typeof reply === "function" ? reply(signal) : chunks(reply);
    },
    keys: { has: async () => options.key ?? true, save: async () => {}, remove: async () => {} },
  };
  return { models, requests, replies };
}

export function settings(values: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = {
    "agentACP.oxbit.api": "openai-compatible", "agentACP.oxbit.baseUrl": "https://models.test/api", "agentACP.oxbit.model": "model-a", ...values,
  };
  return { store, get: (id: string) => store[id], set: (id: string, value: unknown) => void (store[id] = value) };
}

/** The endpoint the `settings` double describes, read the way the app reads OXBIT_AGENT_SETTINGS. */
export function endpointOf(config: ReturnType<typeof settings>): AgentModelEndpoint {
  const api = (config.get("agentACP.oxbit.api") || "openai") as AgentModelApi;
  return api === "openai-compatible" ? { api, baseUrl: String(config.get("agentACP.oxbit.baseUrl") ?? "") } : { api };
}
