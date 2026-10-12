import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TOKENS, anthropicMessages } from "./anthropic-messages.js";
import { chunks, split } from "./test-models.js";
import type { Turn } from "./model.js";

const named = (...events: Record<string, unknown>[]) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const collect = async (items: string[]) => {
  const events = [];
  for await (const event of anthropicMessages.events(chunks(items))) events.push(event);
  return events;
};

describe("Anthropic Messages adapter", () => {
  it("streams thinking, text and a tool_use block with input_json_delta from split chunks", async () => {
    const stream = named(
      { type: "message_start", message: { usage: { input_tokens: 30, cache_read_input_tokens: 5, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "ping" },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 15 } },
      { type: "message_stop" },
    );
    expect(await collect(split(stream, 11))).toEqual([
      { type: "reasoning", text: "Hmm" },
      { type: "text", text: "Reading" },
      { type: "tool_call", call: { id: "toolu_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
      { type: "usage", input: 35, output: 15 },
      { type: "stop", reason: "tool_use", native: [
        { type: "thinking", thinking: "Hmm", signature: "sig" },
        { type: "text", text: "Reading" },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
      ] },
    ]);
  });
  it("maps stop reasons and throws error events", async () => {
    const stop = (reason: string) => named({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 2 } }, { type: "message_stop" });
    expect((await collect([stop("max_tokens")])).at(-1)).toEqual({ type: "stop", reason: "max_tokens", native: [] });
    expect((await collect([stop("refusal")])).at(-1)).toEqual({ type: "stop", reason: "refusal", native: [] });
    await expect(collect([named({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })])).rejects.toThrow("Overloaded");
  });
  it("replays thinking blocks unmodified and puts tool results before the next user text", () => {
    const blocks = [{ type: "thinking", thinking: "Hmm", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }];
    const turns: Turn[] = [
      { role: "user", text: "Read a.ts" },
      { role: "assistant", text: "", calls: [{ id: "toolu_1", name: "read_file", arguments: "{}" }], native: { api: "anthropic", items: blocks } },
      { role: "tool", results: [{ id: "toolu_1", name: "read_file", output: "Cancelled by the user", error: true }] },
      { role: "user", text: "Stop" },
    ];
    const { path, body } = anthropicMessages.request({ model: "m", system: "S", turns, tools: [{ name: "t", description: "d", parameters: { type: "object" } }], effort: "medium" }) as any;
    expect(path).toBe("/v1/messages");
    expect(body).toEqual(expect.objectContaining({ model: "m", system: "S", stream: true, max_tokens: DEFAULT_MAX_TOKENS, output_config: { effort: "medium" },
      tools: [{ name: "t", description: "d", input_schema: { type: "object" } }] }));
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Read a.ts" }] },
      { role: "assistant", content: blocks },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Cancelled by the user", is_error: true }, { type: "text", text: "Stop" }] },
    ]);
  });
});
