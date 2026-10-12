import type { ModelAdapter, ModelEvent, StopReason } from "./model.js";
import { jsonEvents } from "./sse.js";

type Params = Record<string, any>;
/** Used when the model list gave no `max_tokens` for the model. */
export const DEFAULT_MAX_TOKENS = 8192;
const STOP: Record<string, StopReason> = {
  end_turn: "end_turn", stop_sequence: "end_turn", pause_turn: "end_turn", tool_use: "tool_use",
  max_tokens: "max_tokens", model_context_window_exceeded: "max_tokens", refusal: "refusal",
};
const input = (text: string) => {
  try {
    const value = JSON.parse(text || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

/** Anthropic Messages (`api: "anthropic"`), POST /v1/messages with stream: true. The host adds the key and anthropic-version. */
export const anthropicMessages: ModelAdapter = {
  request({ model, system, turns, tools, effort, maxTokens }) {
    const messages: { role: "user" | "assistant"; content: Params[] }[] = [];
    const add = (role: "user" | "assistant", content: Params[]) => {
      const last = messages.at(-1);
      if (last?.role === role) last.content.push(...content);
      else if (content.length) messages.push({ role, content });
    };
    for (const turn of turns) {
      if (turn.role === "user") add("user", [{ type: "text", text: turn.text }]);
      else if (turn.role === "tool")
        add("user", turn.results.map((result) => ({ type: "tool_result", tool_use_id: result.id, content: result.output, ...(result.error ? { is_error: true } : {}) })));
      else if (turn.native?.api === "anthropic") add("assistant", structuredClone(turn.native.items) as Params[]);
      else add("assistant", [...(turn.text ? [{ type: "text", text: turn.text }] : []),
        ...turn.calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: input(call.arguments) }))]);
    }
    return {
      method: "POST",
      path: "/v1/messages",
      body: {
        model, system, messages, stream: true, max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(tools.length ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
        ...(effort ? { output_config: { effort } } : {}),
      },
    };
  },
  async *events(chunks): AsyncGenerator<ModelEvent> {
    const blocks: Params[] = [];
    const json = new Map<number, string>();
    let usage = { input: 0, output: 0 };
    let stop: string | undefined;
    const tokens = (value: Params = {}) => ({
      input: Number.isFinite(value.input_tokens) ? value.input_tokens + (value.cache_read_input_tokens ?? 0) + (value.cache_creation_input_tokens ?? 0) : usage.input,
      output: Number.isFinite(value.output_tokens) ? value.output_tokens : usage.output,
    });
    for await (const event of jsonEvents(chunks)) {
      switch (event.type) {
        case "message_start":
          usage = tokens(event.message?.usage);
          break;
        case "content_block_start":
          blocks[event.index] = { ...event.content_block };
          if (event.content_block?.type === "tool_use") json.set(event.index, "");
          break;
        case "content_block_delta": {
          const block = blocks[event.index];
          const delta = event.delta ?? {};
          if (!block) break;
          if (delta.type === "text_delta") {
            block.text = (block.text ?? "") + delta.text;
            yield { type: "text", text: delta.text };
          } else if (delta.type === "thinking_delta") {
            block.thinking = (block.thinking ?? "") + delta.thinking;
            yield { type: "reasoning", text: delta.thinking };
          } else if (delta.type === "signature_delta") block.signature = (block.signature ?? "") + delta.signature;
          else if (delta.type === "input_json_delta") json.set(event.index, (json.get(event.index) ?? "") + delta.partial_json);
          break;
        }
        case "content_block_stop": {
          const block = blocks[event.index];
          if (block?.type !== "tool_use") break;
          const text = json.get(event.index) || "{}";
          block.input = input(text);
          yield { type: "tool_call", call: { id: block.id, name: block.name, arguments: text } };
          break;
        }
        case "message_delta":
          stop = event.delta?.stop_reason ?? stop;
          usage = tokens(event.usage);
          break;
        case "message_stop":
          yield { type: "usage", ...usage };
          yield { type: "stop", reason: STOP[stop ?? ""] ?? "end_turn", native: blocks.filter(Boolean) };
          return;
        case "error":
          throw new Error(event.error?.message ?? "The model stream failed");
      }
    }
  },
};
