import { graphemes } from "./width.js";

/** Multi-line input text with the cursor as a UTF-16 offset on a grapheme boundary. */
export interface Draft { text: string; cursor: number }

export const emptyDraft: Draft = { text: "", cursor: 0 };
export const draftOf = (text: string): Draft => ({ text, cursor: text.length });

const lineStartOf = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
const lineEndOf = (text: string, at: number) => {
  const end = text.indexOf("\n", at);
  return end < 0 ? text.length : end;
};
const previous = (text: string, at: number) => at - (graphemes(text.slice(Math.max(0, at - 16), at)).at(-1)?.length ?? 0);
const following = (text: string, at: number) => at + (graphemes(text.slice(at, at + 16))[0]?.length ?? 0);

export const insert = ({ text, cursor }: Draft, value: string): Draft =>
  ({ text: text.slice(0, cursor) + value + text.slice(cursor), cursor: cursor + value.length });
export const backspace = ({ text, cursor }: Draft): Draft => {
  const at = previous(text, cursor);
  return { text: text.slice(0, at) + text.slice(cursor), cursor: at };
};
export const deleteForward = ({ text, cursor }: Draft): Draft => ({ text: text.slice(0, cursor) + text.slice(following(text, cursor)), cursor });
export const left = ({ text, cursor }: Draft): Draft => ({ text, cursor: previous(text, cursor) });
export const right = ({ text, cursor }: Draft): Draft => ({ text, cursor: following(text, cursor) });
export const home = ({ text, cursor }: Draft): Draft => ({ text, cursor: lineStartOf(text, cursor) });
export const end = ({ text, cursor }: Draft): Draft => ({ text, cursor: lineEndOf(text, cursor) });

export function wordLeft({ text, cursor }: Draft): Draft {
  let at = cursor;
  while (at > 0 && /\s/.test(text[at - 1])) at--;
  while (at > 0 && !/\s/.test(text[at - 1])) at--;
  return { text, cursor: at };
}
export function wordRight({ text, cursor }: Draft): Draft {
  let at = cursor;
  while (at < text.length && /\s/.test(text[at])) at++;
  while (at < text.length && !/\s/.test(text[at])) at++;
  return { text, cursor: at };
}
export const deleteWordLeft = (draft: Draft): Draft => {
  const at = wordLeft(draft).cursor;
  return { text: draft.text.slice(0, at) + draft.text.slice(draft.cursor), cursor: at };
};
export const killLineLeft = ({ text, cursor }: Draft): Draft => {
  const start = lineStartOf(text, cursor);
  const at = start === cursor && cursor > 0 ? cursor - 1 : start;
  return { text: text.slice(0, at) + text.slice(cursor), cursor: at };
};
export const killLineRight = ({ text, cursor }: Draft): Draft => {
  const stop = lineEndOf(text, cursor);
  return { text: text.slice(0, cursor) + text.slice(stop === cursor ? cursor + 1 : stop), cursor };
};

/** Moves the cursor one line up or down at the same grapheme column; undefined at the first or last line. */
export function vertical({ text, cursor }: Draft, direction: -1 | 1): Draft | undefined {
  const start = lineStartOf(text, cursor);
  const column = graphemes(text.slice(start, cursor)).length;
  const target = direction < 0 ? start - 1 : lineEndOf(text, cursor) + 1;
  if (target < 0 || target > text.length || (direction > 0 && lineEndOf(text, cursor) === text.length)) return undefined;
  const lineStart = lineStartOf(text, target);
  const line = graphemes(text.slice(lineStart, lineEndOf(text, lineStart)));
  return { text, cursor: lineStart + line.slice(0, column).join("").length };
}

/** Lines of the draft with the cursor split out of its line, for rendering. */
export function cursorLines({ text, cursor }: Draft) {
  const lines = text.split("\n");
  let offset = 0;
  return lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    if (cursor < start || cursor > start + line.length) return { before: line };
    const at = cursor - start;
    const under = graphemes(line.slice(at, at + 16))[0] ?? "";
    return { before: line.slice(0, at), under: under || " ", after: line.slice(at + under.length) };
  });
}
