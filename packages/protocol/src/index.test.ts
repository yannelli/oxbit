import { describe, expect, it } from "vitest";
import { MAX_COLLABORATION_UPDATE_BYTES, MAX_FILE_BYTES, MAX_FILE_WRITE_MESSAGE_BYTES, MAX_MESSAGE_BYTES, parseClientMessage, requestMessageLimit } from "./index";

describe("runtime protocol validation", () => {
  it("bounds encoded bytes rather than UTF-16 character count", () => {
    const raw = JSON.stringify({ v: 1, type: "request", id: "one", method: "settings.patch", params: { text: "界".repeat(Math.floor(MAX_MESSAGE_BYTES / 2)) } });
    expect(raw.length).toBeLessThan(MAX_MESSAGE_BYTES); expect(() => parseClientMessage(raw)).toThrow("2 MiB");
  });
  it("reserves enough save bytes for the maximum file with JSON control-character escaping", () => {
    const raw = JSON.stringify({ v: 1, type: "request", id: "one", method: "fs.write", params: { path: "control.txt", text: "\u0001".repeat(MAX_MESSAGE_BYTES), expectedRevision: null } });
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(raw).type).toBe("request");
    const envelopeBytes = new TextEncoder().encode(JSON.stringify({ v: 1, type: "request", id: "x".repeat(128), method: "fs.write", params: { path: "\u0001".repeat(4096), text: "", expectedRevision: "x".repeat(64), encoding: "utf-16le", eol: "CRLF", workspaceId: "default" } })).byteLength;
    const escapedCharacterBytes = JSON.stringify("\u0001").length - 2;
    expect(MAX_FILE_BYTES * escapedCharacterBytes + envelopeBytes).toBeLessThanOrEqual(MAX_FILE_WRITE_MESSAGE_BYTES);
    expect(requestMessageLimit("collab.save")).toBe(MAX_FILE_WRITE_MESSAGE_BYTES);
    expect(requestMessageLimit("collab.update")).toBe(MAX_COLLABORATION_UPDATE_BYTES + MAX_MESSAGE_BYTES);
    expect(requestMessageLimit("settings.patch")).toBe(MAX_MESSAGE_BYTES);
  });
  it("returns protocol errors for malformed JSON and empty routing fields", () => {
    expect(() => parseClientMessage("{")).toThrow("Message is not valid JSON");
    expect(() => parseClientMessage(JSON.stringify({ v: 1, type: "ack", stream: "", seq: 1 }))).toThrow("acknowledgement");
    expect(() => parseClientMessage(JSON.stringify({ v: 1, type: "request", id: "one", method: "", params: {} }))).toThrow("Invalid request");
  });
});
