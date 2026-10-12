import type { ModelAdapter, ModelEvent, StopReason, ToolCall } from "./model.js";
import { jsonEvents } from "./sse.js";

type Params = Record<string, any>;
const STOP: Record<string, StopReason> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

/** Joins streamed OpenRouter `reasoning_details` fragments that share an index. */
function mergeDetails(details: Params[], fragments: unknown) {
  if (!Array.isArray(fragments)) return;
  for (const fragment of fragments as Params[]) {
    const index = Number.isInteger(fragment?.index) ? fragment.index : details.length;
    const current = details[index] ??= {};
    for (const [key, value] of Object.entries(fragment)) {
      if (value === null || value === undefined) continue;
      current[key] = ["text", "summary", "data"].includes(key) && typeof value === "string" ? (current[key] ?? "") + value : value;
    }
  }
}

/** OpenAI Chat Completions (`api: "openai-compatible"`), POST {baseUrl}/v1/chat/completions with stream: true. */
export const chatCompletions: ModelAdapter = {
  request({ model, system, turns, tools, effort }) {
    const messages: Params[] = [{ role: "system", content: system }];
    for (const turn of turns) {
      if (turn.role === "user") messages.push({ role: "user", content: turn.text });
      else if (turn.role === "tool")
        for (const result of turn.results) messages.push({ role: "tool", tool_call_id: result.id, content: result.output });
      else {
        const reasoning = turn.native?.api === "openai-compatible" ? turn.native.items[0] as Params : undefined;
        messages.push({ role: "assistant", content: turn.text || null, ...reasoning,
          ...(turn.calls.length ? { tool_calls: turn.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}) });
      }
    }
    return {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model, messages, stream: true, stream_options: { include_usage: true },
        tools: tools.map((tool) => ({ type: "function", function: tool })),
        ...(effort ? { reasoning_effort: effort } : {}),
      },
    };
  },
  async *events(chunks): AsyncGenerator<ModelEvent> {
    const calls: (ToolCall & { index: number })[] = [];
    const details: Params[] = [];
    let reasoning = "";
    let reasoningKey: "reasoning" | "reasoning_content" | undefined;
    let finish: string | undefined;
    for await (const chunk of jsonEvents(chunks)) {
      if (chunk.error) throw new Error(chunk.error.message ?? "The model stream failed");
      if (chunk.usage) yield { type: "usage", input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
      for (const key of ["reasoning", "reasoning_content"] as const) {
        if (typeof delta[key] !== "string" || !delta[key]) continue;
        reasoningKey ??= key;
        if (key !== reasoningKey) continue;
        reasoning += delta[key];
        yield { type: "reasoning", text: delta[key] };
      }
      mergeDetails(details, delta.reasoning_details);
      for (const fragment of delta.tool_calls ?? []) {
        let call = calls.find((item) => item.index === fragment.index);
        if (!call) calls.push(call = { index: fragment.index ?? calls.length, id: "", name: "", arguments: "" });
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (!finish) return;
    if (finish === "error") throw new Error("The model stream failed");
    for (const { index, ...call } of calls.sort((a, b) => a.index - b.index))
      yield { type: "tool_call", call: { ...call, id: call.id || `call_${index}` } };
    const native = { ...(reasoningKey ? { [reasoningKey]: reasoning } : {}), ...(details.length ? { reasoning_details: details.filter(Boolean) } : {}) };
    yield { type: "stop", reason: calls.length ? "tool_use" : STOP[finish] ?? "end_turn", ...(Object.keys(native).length ? { native: [native] } : {}) };
  },
};
