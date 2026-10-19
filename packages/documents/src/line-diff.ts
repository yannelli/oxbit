import type { TextEdit } from "@oxbit/sdk";

const MAX_DISTANCE = 1000;

/** Pairs of equal lines `[i, j]` in order from Myers' O(ND) diff, or undefined when more than `maxDistance` lines differ. */
function equalLines(a: string[], b: string[], maxDistance: number): [number, number][] | undefined {
  const n = a.length, m = b.length, max = Math.min(n + m, maxDistance), offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x < n || y < m) continue;
      const pairs: [number, number][] = [];
      for (let step = d; step >= 0; step--) {
        const previous = trace[step]!, diagonal = x - y;
        const from = diagonal === -step || (diagonal !== step && previous[offset + diagonal - 1]! < previous[offset + diagonal + 1]!) ? diagonal + 1 : diagonal - 1;
        const startX = previous[offset + from]!, startY = startX - from;
        while (x > startX && y > startY) pairs.push([--x, --y]);
        x = startX; y = startY;
      }
      return pairs.reverse();
    }
  }
  return undefined;
}

/** Narrows an edit to the characters that differ. */
function narrow(previous: string, from: number, to: number, insert: string): TextEdit {
  let start = 0;
  while (start < to - from && start < insert.length && previous[from + start] === insert[start]) start++;
  let end = 0;
  while (end < to - from - start && end < insert.length - start && previous[to - 1 - end] === insert[insert.length - 1 - end]) end++;
  return { from: from + start, to: to - end, insert: insert.slice(start, insert.length - end) };
}

/** Edits that turn `previous` into `next`, one per changed run of lines, so unchanged lines between them keep their decorations. */
export function lineEdits(previous: string, next: string): TextEdit[] {
  if (previous === next) return [];
  const a = previous.split(/(?<=\n)/), b = next.split(/(?<=\n)/);
  const pairs = equalLines(a, b, MAX_DISTANCE);
  if (!pairs) return [narrow(previous, 0, previous.length, next)];
  const starts = [0];
  for (const line of a) starts.push(starts[starts.length - 1]! + line.length);
  const edits: TextEdit[] = [];
  let i = 0, j = 0;
  for (const [x, y] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (x > i || y > j) edits.push(narrow(previous, starts[i]!, starts[x]!, b.slice(j, y).join("")));
    i = x + 1; j = y + 1;
  }
  return edits.filter((edit) => edit.to > edit.from || edit.insert);
}
