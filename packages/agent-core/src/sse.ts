export interface SSEEvent {
  event?: string;
  data: string;
}

async function* lines(chunks: AsyncIterable<string>) {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    for (;;) {
      const end = buffer.search(/\r\n|\r|\n/);
      // A trailing "\r" can be the first half of "\r\n" in the next chunk.
      if (end < 0 || (buffer[end] === "\r" && end === buffer.length - 1)) break;
      yield buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));
    }
  }
  if (buffer) yield buffer.replace(/\r$/, "");
  yield "";
}

/** Server-sent events from streamed text. Ends at a `[DONE]` data line or at the end of the stream. */
export async function* parseSSE(chunks: AsyncIterable<string>): AsyncGenerator<SSEEvent> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of lines(chunks)) {
    if (!line) {
      if (data.length) {
        const payload = data.join("\n");
        if (payload === "[DONE]") return;
        yield { event, data: payload };
      }
      event = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
}

/** Parsed JSON payloads; `type` falls back to the SSE event name. */
export async function* jsonEvents(chunks: AsyncIterable<string>): AsyncGenerator<Record<string, any>> {
  for await (const { event, data } of parseSSE(chunks)) {
    const value = JSON.parse(data);
    if (value && typeof value === "object") yield { ...(event && !value.type ? { type: event } : {}), ...value };
  }
}
