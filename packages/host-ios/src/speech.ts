import { Channel, invoke } from "@tauri-apps/api/core";
import { toError } from "./native.js";

export type SpeechErrorCode =
  | "not-allowed"
  | "service-not-allowed"
  | "audio-capture"
  | "no-speech"
  | "network"
  | "aborted"
  | "language-not-supported";

export interface SpeechAlternative {
  readonly transcript: string;
}

export interface SpeechResult extends ArrayLike<SpeechAlternative> {
  readonly isFinal: boolean;
}

export interface SpeechResultEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechResult>;
}

export interface SpeechErrorEvent {
  readonly error: SpeechErrorCode;
  readonly message: string;
}

type DictationEvent =
  | { type: "start" }
  | { type: "result"; text: string; final: boolean }
  | { type: "error"; error: SpeechErrorCode; message: string }
  | { type: "end" };

const START = "plugin:oxbit-files|start_dictation";
const STOP = "plugin:oxbit-files|stop_dictation";

function resultEvent(transcript: string, isFinal: boolean): SpeechResultEvent {
  return { resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] };
}

/** Web Speech `SpeechRecognition` backed by the oxbit-files plugin's Apple speech recognition. */
export class IosSpeechRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((event: SpeechResultEvent) => void) | null = null;
  onerror: ((event: SpeechErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  private channel: Channel<DictationEvent> | null = null;
  private aborted = false;

  start(): void {
    if (this.channel) throw Object.assign(new Error("Speech recognition has already started"), { name: "InvalidStateError" });
    const channel = new Channel<DictationEvent>();
    channel.onmessage = event => this.receive(channel, event);
    this.channel = channel;
    this.aborted = false;
    invoke(START, { channel, lang: this.lang }).catch((error: unknown) => {
      this.receive(channel, { type: "error", error: "service-not-allowed", message: toError(error).message });
      this.receive(channel, { type: "end" });
    });
  }

  stop(): void {
    this.halt(false);
  }

  abort(): void {
    this.halt(true);
  }

  private halt(abort: boolean): void {
    const channel = this.channel;
    if (!channel) return;
    if (abort) this.aborted = true;
    invoke(STOP, { abort }).catch(() => this.receive(channel, { type: "end" }));
  }

  private receive(channel: Channel<DictationEvent>, event: DictationEvent): void {
    if (channel !== this.channel) return;
    if (event.type === "end") {
      this.channel = null;
      this.onend?.();
    } else if (this.aborted) {
      return;
    } else if (event.type === "start") {
      this.onstart?.();
    } else if (event.type === "result") {
      if (event.final || this.interimResults) this.onresult?.(resultEvent(event.text, event.final));
    } else {
      this.onerror?.({ error: event.error, message: event.message });
    }
  }
}

/** Defines `SpeechRecognition` inside the Tauri web view; other hosts keep their own. */
export function installSpeechRecognition(target: object = globalThis): void {
  if (!("__TAURI_INTERNALS__" in target)) return;
  Object.defineProperty(target, "SpeechRecognition", { value: IosSpeechRecognition, configurable: true, writable: true });
}
