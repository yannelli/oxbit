import { describe, expect, it } from "vitest";
import { jsonEvents, parseSSE } from "./sse.js";

async function* stream(...chunks: string[]) {
  yield* chunks;
}
const collect = async <T>(items: AsyncIterable<T>) => {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
};

describe("parseSSE", () => {
  it("joins lines split across chunks and reads event and data fields", async () => {
    const events = await collect(parseSSE(stream("event: a\nda", "ta: {\"x\":", "1}\n", "\nevent:b\ndata:2\n\n")));
    expect(events).toEqual([{ event: "a", data: "{\"x\":1}" }, { event: "b", data: "2" }]);
  });
  it("handles CRLF split between chunks, comments and multi-line data", async () => {
    const events = await collect(parseSSE(stream(": OPENROUTER PROCESSING\r\n\r\ndata: one\r", "\ndata: two\r\n\r\n")));
    expect(events).toEqual([{ event: undefined, data: "one\ntwo" }]);
  });
  it("stops at [DONE] and flushes a final event without a blank line", async () => {
    expect(await collect(parseSSE(stream("data: 1\n\ndata: [DONE]\n\ndata: 2\n\n")))).toEqual([{ event: undefined, data: "1" }]);
    expect(await collect(parseSSE(stream("data: last")))).toEqual([{ event: undefined, data: "last" }]);
  });
  it("parses JSON payloads and names untyped ones after the event", async () => {
    expect(await collect(jsonEvents(stream("event: ping\ndata: {}\n\ndata: {\"type\":\"x\"}\n\n")))).toEqual([{ type: "ping" }, { type: "x" }]);
  });
});
