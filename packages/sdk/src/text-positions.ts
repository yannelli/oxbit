export interface TextPosition { line: number; character: number }
export function textOffset(text: string, pos: TextPosition): number {
  const lines = text.split("\n");
  if (!Number.isInteger(pos.line) || pos.line < 0 || pos.line >= lines.length) throw new Error("Language server returned an invalid line");
  if (!Number.isInteger(pos.character) || pos.character < 0 || pos.character > lines[pos.line].replace(/\r$/, "").length) throw new Error("Language server returned an invalid column");
  let at = 0;
  for (let line = 0; line < pos.line; line++) at += lines[line].length + 1;
  return at + pos.character;
}
export function textPosition(text: string, at: number): TextPosition {
  if (!Number.isInteger(at) || at < 0 || at > text.length) throw new Error("Invalid document offset");
  const lines = text.slice(0, at).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.replace(/\r$/, "").length };
}

/** Smallest single UTF-16 replacement, keeping CRLF and surrogate pairs intact. */
export function incrementalChange(before: string, after: string) {
  let from = 0, oldEnd = before.length, newEnd = after.length;
  while (from < oldEnd && from < newEnd && before[from] === after[from]) from++;
  const boundary = (text: string, at: number) => at > 0 && (text[at - 1] === "\r" && text[at] === "\n" || /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at] ?? ""));
  if (boundary(before, from) || boundary(after, from)) from--;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  if (boundary(before, oldEnd) || boundary(after, newEnd)) { oldEnd++; newEnd++; }
  return { range: { start: textPosition(before, from), end: textPosition(before, oldEnd) }, text: after.slice(from, newEnd) };
}
