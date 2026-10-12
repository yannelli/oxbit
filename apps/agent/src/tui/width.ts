const segmenter = new Intl.Segmenter();
const ANSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u;
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|\p{Regional_Indicator}/u;
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

export const stripAnsi = (text: string) => text.replace(ANSI, "");
export const graphemes = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment);

/** Terminal cells for one grapheme cluster, matching string-width for East Asian wide characters and emoji. */
export function cellWidth(grapheme: string) {
  if (!grapheme || ZERO.test(grapheme)) return 0;
  if (EMOJI.test(grapheme)) return 2;
  const code = grapheme.codePointAt(0)!;
  return WIDE.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}

export function width(text: string) {
  let total = 0;
  for (const grapheme of graphemes(stripAnsi(text))) total += cellWidth(grapheme);
  return total;
}

/** Cuts plain text to `max` cells with a trailing ellipsis. */
export function truncate(text: string, max: number) {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const grapheme of graphemes(text)) {
    const size = cellWidth(grapheme);
    if (used + size > max - 1) break;
    out += grapheme;
    used += size;
  }
  return `${out}…`;
}

/** Keeps the end of plain text within `max` cells, for paths. */
export function truncateStart(text: string, max: number) {
  if (width(text) <= max) return text;
  const parts = graphemes(text);
  let out = "";
  let used = 0;
  for (let index = parts.length - 1; index >= 0; index--) {
    const size = cellWidth(parts[index]);
    if (used + size > max - 1) break;
    out = parts[index] + out;
    used += size;
  }
  return `…${out}`;
}
