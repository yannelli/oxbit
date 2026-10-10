import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: (event: unknown) => void = () => undefined;
  },
}));

const { IosSpeechRecognition, installSpeechRecognition } = await import("./speech.js");
type Recognition = InstanceType<typeof IosSpeechRecognition>;

function started(lang = "en-US") {
  const recognition = new IosSpeechRecognition();
  recognition.lang = lang;
  recognition.interimResults = true;
  const events: unknown[] = [];
  recognition.onstart = () => events.push("start");
  recognition.onresult = event => events.push({ resultIndex: event.resultIndex, length: event.results.length, isFinal: event.results[0]!.isFinal, transcript: event.results[0]![0]!.transcript });
  recognition.onerror = event => events.push({ error: event.error, message: event.message });
  recognition.onend = () => events.push("end");
  recognition.start();
  const channel = invoke.mock.calls.at(-1)![1].channel as { onmessage: (event: unknown) => void };
  return { recognition, events, send: (event: unknown) => channel.onmessage(event) };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("IosSpeechRecognition", () => {
  it("starts native dictation with the channel and language", () => {
    const { send, events } = started("de-DE");
    expect(invoke).toHaveBeenCalledWith("plugin:oxbit-files|start_dictation", { channel: expect.any(Object), lang: "de-DE" });
    send({ type: "start" });
    expect(events).toEqual(["start"]);
  });

  it("replaces the utterance at index 0 with partial then final results", () => {
    const { send, events } = started();
    send({ type: "result", text: "hello", final: false });
    send({ type: "result", text: "hello world", final: true });
    send({ type: "end" });
    expect(events).toEqual([
      { resultIndex: 0, length: 1, isFinal: false, transcript: "hello" },
      { resultIndex: 0, length: 1, isFinal: true, transcript: "hello world" },
      "end",
    ]);
  });

  it("reports an error then ends", () => {
    const { send, events } = started();
    send({ type: "error", error: "not-allowed", message: "Microphone access is not allowed" });
    send({ type: "end" });
    expect(events).toEqual([{ error: "not-allowed", message: "Microphone access is not allowed" }, "end"]);
  });

  it("maps a rejected start to an error then end", async () => {
    invoke.mockRejectedValueOnce("Command start_dictation not allowed by ACL");
    const { events } = started();
    await vi.waitFor(() => expect(events).toEqual([{ error: "service-not-allowed", message: "Command start_dictation not allowed by ACL" }, "end"]));
  });

  it("stops with abort false and aborts with abort true", () => {
    const first = started();
    first.recognition.stop();
    expect(invoke).toHaveBeenLastCalledWith("plugin:oxbit-files|stop_dictation", { abort: false });
    first.send({ type: "end" });
    const second = started();
    second.recognition.abort();
    expect(invoke).toHaveBeenLastCalledWith("plugin:oxbit-files|stop_dictation", { abort: true });
    second.send({ type: "result", text: "late", final: true });
    second.send({ type: "end" });
    expect(second.events).toEqual(["end"]);
  });

  it("throws InvalidStateError when started twice", () => {
    const { recognition, send } = started();
    expect(() => recognition.start()).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    send({ type: "end" });
    expect(() => recognition.start()).not.toThrow();
  });
});

describe("installSpeechRecognition", () => {
  it("defines SpeechRecognition only inside Tauri", () => {
    const tauri: { __TAURI_INTERNALS__: object; SpeechRecognition?: new () => Recognition } = { __TAURI_INTERNALS__: {} };
    const browser: { SpeechRecognition?: unknown } = {};
    installSpeechRecognition(tauri);
    installSpeechRecognition(browser);
    expect(tauri.SpeechRecognition).toBe(IosSpeechRecognition);
    expect(browser).not.toHaveProperty("SpeechRecognition");
  });
});
