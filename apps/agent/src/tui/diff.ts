export type DiffLine =
  | { type: "context" | "added" | "removed"; text: string; oldNo?: number; newNo?: number }
  | { type: "gap"; count: number };
export interface FileDiff { lines: DiffLine[]; added: number; removed: number }

const MAX_CELLS = 4_000_000;
const split = (text: string) => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** Edit script of the middle section by LCS; larger inputs fall back to remove-all, add-all. */
function middle(a: string[], b: string[]): ("=" | "-" | "+")[] {
  if (!a.length || !b.length || a.length * b.length > MAX_CELLS)
    return [...a.map(() => "-" as const), ...b.map(() => "+" as const)];
  const columns = b.length + 1;
  const table = new Uint32Array((a.length + 1) * columns);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * columns + j] = a[i] === b[j] ? table[(i + 1) * columns + j + 1] + 1 : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
  const ops: ("=" | "-" | "+")[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push("="); i++; j++; }
    else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) { ops.push("-"); i++; }
    else { ops.push("+"); j++; }
  }
  while (i++ < a.length) ops.push("-");
  while (j++ < b.length) ops.push("+");
  return ops;
}

/** Line diff of an ACP diff block with `context` unchanged lines around each change and gaps for the rest. */
export function diffLines(oldText: string | null | undefined, newText: string, context = 3): FileDiff {
  const a = oldText ? split(oldText) : [];
  const b = split(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops = [...Array<"=">(head).fill("="), ...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)), ...Array<"=">(tail).fill("=")];
  const all: Extract<DiffLine, { text: string }>[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const op of ops) {
    if (op === "=") all.push({ type: "context", text: b[newNo], oldNo: ++oldNo, newNo: ++newNo });
    else if (op === "-") all.push({ type: "removed", text: a[oldNo], oldNo: ++oldNo });
    else all.push({ type: "added", text: b[newNo], newNo: ++newNo });
  }
  const near = all.map(() => false);
  all.forEach((line, index) => {
    if (line.type === "context") return;
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) near[k] = true;
  });
  const lines: DiffLine[] = [];
  let skipped = 0;
  all.forEach((line, index) => {
    if (near[index]) {
      if (skipped) lines.push({ type: "gap", count: skipped });
      skipped = 0;
      lines.push(line);
    } else skipped++;
  });
  if (skipped && lines.length) lines.push({ type: "gap", count: skipped });
  return { lines, added: all.filter((line) => line.type === "added").length, removed: all.filter((line) => line.type === "removed").length };
}
