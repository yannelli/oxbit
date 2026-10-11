import { describe, expect, it } from "vitest";
import { openaiResponses } from "./openai-responses.js";
import { chunks, split } from "./test-models.js";
import type { Turn } from "./model.js";

const named = (...events: Record<string, unknown>[]) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const collect = async (items: string[]) => {
  const events = [];
  for await (const event of openaiResponses.events(chunks(items))) events.push(event);
  return events;
};
const reasoning = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Plan" }] };
const call = { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}", status: "completed" };

describe("OpenAI Responses adapter", () => {
  it("streams reasoning, text and a completed function call from split chunks", async () => {
    const stream = named(
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Plan" },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "Hi" },
      { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: "{\"path\"" },
      { type: "response.output_item.done", output_index: 2, item: call },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } } },
    );
    expect(await collect(split(stream, 9))).toEqual([
      { type: "reasoning", text: "Plan" },
      { type: "text", text: "Hi" },
      { type: "tool_call", call: { id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
      { type: "usage", input: 20, output: 4 },
      { type: "stop", reason: "tool_use", native: [reasoning, call] },
    ]);
  });
  it("maps incomplete responses and throws failures and error events", async () => {
    expect((await collect([named({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } })])).at(-1))
      .toEqual({ type: "stop", reason: "max_tokens", native: [] });
    await expect(collect([named({ type: "response.failed", response: { error: { code: "server_error", message: "Broken" } } })])).rejects.toThrow("Broken");
    await expect(collect([named({ type: "error", code: null, message: "Bad request", param: null })])).rejects.toThrow("Bad request");
  });
  it("replays native output items verbatim and converts other turns to input items", () => {
    const turns: Turn[] = [
      { role: "user", text: "Read a.ts" },
      { role: "assistant", text: "", calls: [{ id: "call_1", name: "read_file", arguments: call.arguments }], native: { api: "openai", items: [reasoning, call] } },
      { role: "tool", results: [{ id: "call_1", name: "read_file", output: "text" }] },
      { role: "assistant", text: "Done", calls: [] },
    ];
    const { path, body } = openaiResponses.request({ model: "m", system: "S", turns, tools: [{ name: "t", description: "d", parameters: {} }], effort: "high" }) as any;
    expect(path).toBe("/v1/responses");
    expect(body).toEqual(expect.objectContaining({ model: "m", instructions: "S", stream: true, reasoning: { effort: "high", summary: "auto" },
      tools: [{ type: "function", name: "t", description: "d", parameters: {}, strict: false }] }));
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Read a.ts" }] },
      reasoning, call,
      { type: "function_call_output", call_id: "call_1", output: "text" },
      { type: "message", role: "assistant", content: "Done" },
    ]);
  });
});
