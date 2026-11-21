import type { Setting } from "@oxbit/sdk";
import { translate as tr } from "@oxbit/ui";

export interface JsonErrorLocation { line: number; column: number; offset: number; message: string }

function lineColumn(text: string, offset: number) {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

/** Offset of the first syntax error, found with a small JSON scanner; -1 when the text is valid. */
export function scanJsonError(text: string): number {
  let i = 0;
  const fail = (): never => { throw i; };
  const space = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const word = (literal: string) => { if (text.startsWith(literal, i)) i += literal.length; else fail(); };
  const string = () => {
    i++;
    while (text[i] !== "\"") {
      if (i >= text.length || text[i] < " ") fail();
      if (text[i] === "\\") {
        i++;
        if (text[i] === "u") { if (!/^[\da-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail(); i += 4; }
        else if (i >= text.length || !"\"\\/bfnrt".includes(text[i])) fail();
      }
      i++;
    }
    i++;
  };
  const number = () => {
    const pattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    pattern.lastIndex = i;
    const match = pattern.exec(text);
    if (!match) fail(); else i += match[0].length;
  };
  const list = (close: string, item: () => void) => {
    i++; space();
    if (text[i] === close) { i++; return; }
    for (;;) {
      item(); space();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === close) { i++; return; }
      fail();
    }
  };
  const value = (): void => {
    space();
    const char = text[i];
    if (char === "{") list("}", () => { space(); if (text[i] !== "\"") fail(); string(); space(); if (text[i] !== ":") fail(); i++; value(); });
    else if (char === "[") list("]", value);
    else if (char === "\"") string();
    else if (char === "t") word("true");
    else if (char === "f") word("false");
    else if (char === "n") word("null");
    else number();
  };
  try {
    value(); space();
    if (i < text.length) fail();
    return -1;
  } catch (offset) {
    return typeof offset === "number" ? offset : -1;
  }
}

/** Line and column of a `JSON.parse` failure, from the engine message or the scanner. */
export function jsonErrorLocation(text: string, message: string): JsonErrorLocation | undefined {
  const detail = message
    .replace(/\s+in JSON at position \d+(?: \(line \d+ column \d+\))?$/, "")
    .replace(/\s+at line \d+ column \d+ of the JSON data$/, "");
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) {
    const line = Number(lc[1]), column = Number(lc[2]);
    const lines = text.split("\n");
    const offset = lines.slice(0, line - 1).reduce((sum, item) => sum + item.length + 1, 0) + column - 1;
    return { line, column, offset: Math.min(offset, text.length), message: detail };
  }
  const position = /position (\d+)/.exec(message);
  const offset = position ? Number(position[1]) : scanJsonError(text);
  if (offset < 0) return undefined;
  return { ...lineColumn(text, offset), offset, message: detail };
}

function jsonType(value: unknown) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** Non-blocking notes: keys that no setting registers, and values of the wrong JSON type. */
export function settingWarnings(settings: Setting[], layer: Record<string, unknown>): string[] {
  const byId = new Map(settings.map(setting => [setting.id, setting]));
  return Object.entries(layer).flatMap(([key, value]) => {
    const setting = byId.get(key);
    if (!setting) return [tr("{0} is not a registered setting.", { "0": key })];
    const actual = jsonType(value);
    return actual === setting.type ? [] : [tr("{0} expects a {1} value, found {2}.", { "0": key, "1": setting.type, "2": actual })];
  });
}

/** Tab and Shift-Tab in a textarea: two spaces per level, across every selected line. */
export function indentText(value: string, start: number, end: number, outdent: boolean) {
  if (!outdent && !value.slice(start, end).includes("\n"))
    return { value: value.slice(0, start) + "  " + value.slice(end), start: start + 2, end: start + 2 };
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const to = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = value.indexOf("\n", to);
  const block = value.slice(from, lineEnd < 0 ? value.length : lineEnd).split("\n");
  const deltas = block.map(line => outdent ? -(/^ {0,2}/.exec(line)?.[0].length ?? 0) : 2);
  const next = block.map((line, index) => outdent ? line.slice(-deltas[index]) : "  " + line);
  const total = deltas.reduce((sum, delta) => sum + delta, 0);
  const result = value.slice(0, from) + next.join("\n") + value.slice(lineEnd < 0 ? value.length : lineEnd);
  const nextStart = Math.max(from, start + deltas[0]);
  return { value: result, start: nextStart, end: Math.max(nextStart, end + total) };
}
