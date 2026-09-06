import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, parseClientMessage } from "./index";

describe("runtime protocol validation", () => {
  it("bounds encoded bytes rather than UTF-16 character count", () => {
    const raw = JSON.stringify({ v: 1, type: "request", id: "one", method: "fs.write", params: { text: "界".repeat(Math.floor(MAX_MESSAGE_BYTES / 2)) } });
    expect(raw.length).toBeLessThan(MAX_MESSAGE_BYTES); expect(() => parseClientMessage(raw)).toThrow("2 MiB");
  });
  it("returns protocol errors for malformed JSON and empty routing fields", () => {
    expect(() => parseClientMessage("{")).toThrow("Message is not valid JSON");
    expect(() => parseClientMessage(JSON.stringify({ v: 1, type: "ack", stream: "", seq: 1 }))).toThrow("acknowledgement");
    expect(() => parseClientMessage(JSON.stringify({ v: 1, type: "request", id: "one", method: "", params: {} }))).toThrow("Invalid request");
  });
});
