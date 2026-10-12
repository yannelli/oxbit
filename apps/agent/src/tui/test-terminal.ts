import { EventEmitter } from "node:events";
import { stripAnsi } from "./width.js";

export const KEYS = {
  enter: "\r", escape: "\x1b", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", tab: "\t", shiftTab: "\x1b[Z",
  ctrlC: "\x03", ctrlO: "\x0f", ctrlU: "\x15", altEnter: "\x1b\r", shiftEnter: "\x1b[13;2u", backspace: "\x7f",
};

/** A TTY-like stdout that records every write; Ink's debug mode writes each frame in full. */
export class FakeStdout extends EventEmitter {
  isTTY = true;
  writes: string[] = [];
  constructor(public columns = 100, public rows = 30) {
    super();
  }
  write(chunk: string | Uint8Array, ...rest: unknown[]) {
    this.writes.push(String(chunk));
    const callback = rest.find((value) => typeof value === "function") as (() => void) | undefined;
    callback?.();
    return true;
  }
  /** Rendered frames as plain text, without writes that only carry escape sequences. */
  frames() {
    return this.writes.map(stripAnsi).filter((text) => text.trim());
  }
  frame() {
    return this.frames().at(-1) ?? "";
  }
}

/** A raw-mode stdin that delivers queued key presses through the "readable" event Ink listens for. */
export class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode() { return this; }
  setEncoding() { return this; }
  ref() { return this; }
  unref() { return this; }
  resume() { return this; }
  pause() { return this; }
  read() {
    return this.queue.shift() ?? null;
  }
  press(...keys: string[]) {
    for (const key of keys) {
      this.queue.push(key);
      this.emit("readable");
    }
  }
}

export function terminal(columns = 100, rows = 30) {
  const stdout = new FakeStdout(columns, rows);
  const stdin = new FakeStdin();
  const stderr = new FakeStdout(columns, rows);
  const streams = { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: stderr as unknown as NodeJS.WriteStream };
  return { stdout, stdin, stderr, streams };
}

/** Polls until `check` passes; throws with the last frame after `timeout` ms. */
export async function waitFor(check: () => boolean, describe: () => string = () => "", timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting. Last frame:\n${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
