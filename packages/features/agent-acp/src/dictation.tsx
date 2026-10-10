import { useEffect, useRef, useState } from "react";
import { Icon, translate as tr } from "@oxbit/ui";

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly [index: number]: { readonly transcript: string } | undefined;
}
export interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult };
}
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;

export function recognitionConstructor(scope: object = globalThis): RecognitionConstructor | undefined {
  const speech = scope as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
}

const errorMessages: Record<string, string> = {
  "not-allowed": "Allow microphone access for Oxbit to dictate",
  "service-not-allowed": "Allow speech recognition for Oxbit to dictate",
  "audio-capture": "No microphone is available",
  network: "Dictation needs a network connection",
  "language-not-supported": "Dictation does not support this language",
  "no-speech": "No speech was detected",
};

export function spokenText(event: RecognitionEvent) {
  let text = "";
  for (let index = 0; index < event.results.length; index++)
    text += event.results[index]?.[0]?.transcript ?? "";
  return text.trim();
}

export function joinDictation(prefix: string, spoken: string) {
  if (!spoken) return prefix;
  return prefix && !/\s$/.test(prefix) ? `${prefix} ${spoken}` : prefix + spoken;
}

/** Appends speech to the draft. Editing or sending the draft stops dictation. */
export function DictationButton({ value, onChange, onError }: {
  value: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const session = useRef<{ recognition: Recognition; written: string } | null>(null);
  const latest = useRef({ value, onChange, onError });
  latest.current = { value, onChange, onError };
  useEffect(() => () => session.current?.recognition.abort(), []);
  useEffect(() => {
    if (session.current && value !== session.current.written) session.current.recognition.abort();
  }, [value]);
  const Recognition = recognitionConstructor();
  if (!Recognition) return null;
  const start = () => {
    const recognition = new Recognition();
    const prefix = latest.current.value;
    const current = { recognition, written: prefix };
    recognition.lang = navigator.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (session.current !== current) return;
      current.written = joinDictation(prefix, spokenText(event));
      latest.current.onChange(current.written);
    };
    recognition.onerror = (event) => {
      const message = errorMessages[event.error];
      if (message) latest.current.onError(tr(message));
    };
    recognition.onend = () => {
      if (session.current !== current) return;
      session.current = null;
      setListening(false);
    };
    try {
      recognition.start();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      return;
    }
    session.current = current;
    setListening(true);
  };
  const label = tr(listening ? "Stop dictation" : "Dictate");
  return (
    <button
      type="button"
      className="icon-button acp-mic"
      aria-label={label}
      aria-pressed={listening}
      data-tooltip={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => (listening ? session.current?.recognition.stop() : start())}
    >
      <Icon name="mic" />
    </button>
  );
}
