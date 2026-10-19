import { describe, expect, it } from "vitest";
import { chatCompletions } from "./chat-completions.js";
import { withOutputLimit } from "./turn.js";
import { chunks, split, sse } from "./test-models.js";
import type { Turn } from "./model.js";

const collect = async (items: string[]) => {
  const events = [];
  for await (const event of chatCompletions.events(chunks(items))) events.push(event);
  return events;
};

describe("Chat Completions adapter", () => {
  it("streams text, reasoning and indexed tool call deltas from split chunks", async () => {
    const stream = sse(
      { choices: [{ index: 0, delta: { role: "assistant", reasoning: "Think", reasoning_details: [{ type: "reasoning.text", text: "Th", index: 0 }] } }] },
      { choices: [{ index: 0, delta: { content: "Hi", reasoning_details: [{ type: "reasoning.text", text: "ink", signature: "s", index: 0 }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"pa" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "list_files", arguments: "{}" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a.ts\"}" } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
    ).join("");
    expect(await collect([": OPENROUTER PROCESSING\n\n", ...split(stream, 7)])).toEqual([
      { type: "reasoning", text: "Think" },
      { type: "text", text: "Hi" },
      { type: "usage", input: 12, output: 5 },
      { type: "tool_call", call: { id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
      { type: "tool_call", call: { id: "call_2", name: "list_files", arguments: "{}" } },
      { type: "stop", reason: "tool_use", native: [{ reasoning: "Think", reasoning_details: [{ type: "reasoning.text", text: "Think", signature: "s", index: 0 }] }] },
    ]);
  });
  it("maps finish reasons, reports stream errors and ends without a stop when finish_reason is missing", async () => {
    expect((await collect(sse({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "length" }] }))).at(-1)).toEqual({ type: "stop", reason: "max_tokens" });
    await expect(collect(sse({ error: { message: "Provider down" }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] }))).rejects.toThrow("Provider down");
    expect(await collect(["data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"}}]}\n\n"])).toEqual([{ type: "text", text: "x" }]);
  });
  it("builds messages with tool calls, tool results and replayed reasoning", () => {
    const turns: Turn[] = [
      { role: "user", text: "Read a.ts" },
      { role: "assistant", text: "", calls: [{ id: "call_1", name: "read_file", arguments: "{}" }], native: { api: "openai-compatible", items: [{ reasoning_content: "R" }] } },
      { role: "tool", results: [{ id: "call_1", name: "read_file", output: "text" }] },
    ];
    const { path, body } = chatCompletions.request({ model: "m", system: "S", turns, tools: [{ name: "t", description: "d", parameters: {} }], effort: "low" }) as any;
    expect(path).toBe("/v1/chat/completions");
    expect(body).toEqual(expect.objectContaining({ model: "m", stream: true, stream_options: { include_usage: true }, reasoning_effort: "low",
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: {} } }] }));
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "Read a.ts" },
      { role: "assistant", content: null, reasoning_content: "R", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "text" },
    ]);
  });

  it("adds the output cap that each API reads to a one-shot request", () => {
    const request = chatCompletions.request({ model: "m", system: "S", turns: [], tools: [] });
    expect(withOutputLimit("openai-compatible", request, 64).body).toMatchObject({ model: "m", max_tokens: 64 });
    expect(withOutputLimit("openai", { body: {} }, 64).body).toEqual({ max_output_tokens: 64 });
    expect(withOutputLimit("chatgpt", request, 64)).toBe(request);
    expect(withOutputLimit("openai-compatible", request)).toBe(request);
  });
});
