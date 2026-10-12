import type { AgentModelApi } from "@oxbit/sdk";
import type { ModelAdapter, ModelEvent, ModelInput } from "./model.js";
import { jsonEvents } from "./sse.js";

type Params = Record<string, any>;

/** With store: false, reasoning replays only with encrypted_content. Dropping older reasoning also drops the other items' ids, which the API pairs with it. */
function replayable(items: Params[]) {
  const kept = items.filter((item) => item.type !== "reasoning" || item.encrypted_content);
  return kept.length === items.length ? items
    : kept.map((item) => item.type === "reasoning" ? item : Object.fromEntries(Object.entries(item).filter(([key]) => key !== "id")));
}

/** A Responses request body with stream: true and store: false. Assistant turns saved by an API in `replay` resend their output items. */
export function responsesBody({ model, system, turns, tools, effort }: ModelInput, replay: readonly AgentModelApi[]) {
  const input: Params[] = [];
  for (const turn of turns) {
    if (turn.role === "user") input.push({ type: "message", role: "user", content: [{ type: "input_text", text: turn.text }] });
    else if (turn.role === "tool")
      for (const result of turn.results) input.push({ type: "function_call_output", call_id: result.id, output: result.output });
    else if (turn.native && replay.includes(turn.native.api)) input.push(...replayable(turn.native.items as Params[]));
    else {
      if (turn.text) input.push({ type: "message", role: "assistant", content: turn.text });
      for (const call of turn.calls) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
    }
  }
  return {
    model, instructions: system, input, stream: true, store: false,
    ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", ...tool, strict: false })) } : {}),
    ...(effort ? { reasoning: { effort, summary: "auto" } } : {}),
  };
}

/** OpenAI Responses (`api: "openai"`), POST /v1/responses; turns replay as input items. */
export const openaiResponses: ModelAdapter = {
  request: (input) => ({ method: "POST", path: "/v1/responses", body: responsesBody(input, ["openai"]) }),
  async *events(chunks): AsyncGenerator<ModelEvent> {
    const items: Params[] = [];
    for await (const event of jsonEvents(chunks)) {
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield { type: "text", text: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (event.delta) yield { type: "reasoning", text: event.delta };
          break;
        case "response.reasoning_summary_part.added":
          if (event.summary_index > 0) yield { type: "reasoning", text: "\n\n" };
          break;
        case "response.output_item.done":
          items[event.output_index ?? items.length] = event.item;
          if (event.item?.type === "function_call")
            yield { type: "tool_call", call: { id: event.item.call_id, name: event.item.name, arguments: event.item.arguments ?? "" } };
          break;
        case "response.completed":
        case "response.incomplete": {
          const { usage, incomplete_details: incomplete } = event.response ?? {};
          if (usage) yield { type: "usage", input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 };
          const native = items.filter(Boolean);
          const reason = native.some((item) => item.type === "function_call") ? "tool_use"
            : event.type === "response.completed" ? "end_turn" : incomplete?.reason === "content_filter" ? "refusal" : "max_tokens";
          yield { type: "stop", reason, native };
          return;
        }
        case "response.failed":
          throw new Error(event.response?.error?.message ?? "The model response failed");
        case "error":
          throw new Error(event.message ?? "The model stream failed");
      }
    }
  },
};
