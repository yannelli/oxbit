import { describe, expect, it } from "vitest";
import { joinDictation, recognitionConstructor, spokenText, type RecognitionEvent } from "./dictation.js";

const event = (...parts: [string, boolean][]): RecognitionEvent => ({
  resultIndex: 0,
  results: Object.assign(parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })), {}),
});

describe("dictation", () => {
  it("joins every result and trims the edges", () => {
    expect(spokenText(event(["fix the", true], [" login bug ", false]))).toBe("fix the login bug");
    expect(spokenText(event())).toBe("");
  });
  it("separates speech from the draft with one space", () => {
    expect(joinDictation("", "hello")).toBe("hello");
    expect(joinDictation("Fix", "the bug")).toBe("Fix the bug");
    expect(joinDictation("Fix\n", "the bug")).toBe("Fix\nthe bug");
    expect(joinDictation("Fix", "")).toBe("Fix");
  });
  it("prefers the unprefixed constructor", () => {
    class Native {}
    class Prefixed {}
    expect(recognitionConstructor({ SpeechRecognition: Native, webkitSpeechRecognition: Prefixed })).toBe(Native);
    expect(recognitionConstructor({ webkitSpeechRecognition: Prefixed })).toBe(Prefixed);
    expect(recognitionConstructor({})).toBeUndefined();
  });
});
