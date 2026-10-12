export type Align = "left" | "center" | "right";
export interface ListItem { depth: number; marker: string; text: string; checked?: boolean }
export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; lines: string[]; open: boolean }
  | { type: "list"; items: ListItem[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { type: "rule" };
export interface Span { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; link?: string }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
const closes = (line: string, fence: string) => line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim()) && line.trim()[0] === fence[0];
const startsBlock = (line: string, next?: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST.test(line) || QUOTE.test(line)
  || (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes("-"));

/** Block structure of CommonMark-style text. Unclosed fences become open code blocks, so partial streams parse. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      const indent = line.length - line.trimStart().length;
      index++;
      while (index < lines.length && !closes(lines[index], fence[1])) body.push(lines[index++].replace(new RegExp(`^ {0,${indent}}`), ""));
      blocks.push({ type: "code", lang: fence[2] ?? "", lines: body, open: index >= lines.length });
      index++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, text: heading[2] ?? "" }); index++; continue; }
    if (RULE.test(line)) { blocks.push({ type: "rule" }); index++; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && lines[index].trim()) {
        const quoted = QUOTE.exec(lines[index]);
        if (!quoted && startsBlock(lines[index])) break;
        body.push(quoted ? quoted[1] : lines[index].trim());
        index++;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(body.join("\n")) });
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]) && lines[index + 1].includes("-")) {
      const head = cells(line);
      const align = cells(lines[index + 1]).map((cell): Align => cell.endsWith(":") ? cell.startsWith(":") ? "center" : "right" : "left");
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(cells(lines[index++]));
      blocks.push({ type: "table", head, align, rows });
      continue;
    }
    if (LIST.test(line)) { index = parseList(lines, index, blocks); continue; }
    const body = [line.trim()];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index], lines[index + 1])) {
      if (/^ {0,3}=+\s*$/.test(lines[index]) || /^ {0,3}-+\s*$/.test(lines[index])) break;
      body.push(lines[index++].trim());
    }
    const setext = lines[index]?.trim();
    if (setext && /^(=+|-+)$/.test(setext)) {
      blocks.push({ type: "heading", level: setext[0] === "=" ? 1 : 2, text: body.join(" ") });
      index++;
    } else blocks.push({ type: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

function parseList(lines: string[], start: number, blocks: Block[]) {
  const items: ListItem[] = [];
  const indents: number[] = [];
  const counters: number[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    const match = LIST.exec(line);
    if (match && !RULE.test(line)) {
      const indent = match[1].length;
      while (indents.length && indent < indents.at(-1)!) { indents.pop(); counters.pop(); }
      if (!indents.length || indent > indents.at(-1)! + 1) { indents.push(indent); counters.push(0); }
      const depth = indents.length - 1;
      const ordered = /\d/.test(match[2]);
      counters[depth] = ordered ? (counters[depth] || Number.parseInt(match[2], 10) - 1) + 1 : 0;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(match[3] ?? "");
      items.push({ depth, marker: ordered ? `${counters[depth]}.` : "-", text: task ? task[2] : match[3] ?? "",
        ...(task ? { checked: task[1] !== " " } : {}) });
      index++;
    } else if (line.trim() && items.length && !startsBlock(line)) {
      items.at(-1)!.text += `\n${line.trim()}`;
      index++;
    } else if (!line.trim() && index + 1 < lines.length && (LIST.test(lines[index + 1]) || /^\s{2,}\S/.test(lines[index + 1]))) index++;
    else break;
  }
  blocks.push({ type: "list", items });
  return index;
}

const flanked = (text: string, at: number, size: number) => text[at + size] !== undefined && !/\s/.test(text[at + size]);
const merge = (spans: Span[]) => spans.reduce<Span[]>((out, span) => {
  const last = out.at(-1);
  const { text: _a, ...left } = last ?? { text: "" };
  const { text: _b, ...right } = span;
  if (last && JSON.stringify(left) === JSON.stringify(right)) last.text += span.text;
  else if (span.text) out.push({ ...span });
  return out;
}, []);

/** Inline Markdown as styled spans. Unmatched markers stay literal, which keeps partial streams readable. */
export function parseInline(text: string, style: Omit<Span, "text"> = {}): Span[] {
  const spans: Span[] = [];
  let plain = "";
  const push = (...items: Span[]) => { if (plain) spans.push({ ...style, text: plain }); plain = ""; spans.push(...items); };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const rest = text.slice(index);
    if (char === "\\" && /[\\`*_{}[\]()#+\-.!|~<>]/.test(text[index + 1] ?? "")) { plain += text[index + 1]; index += 2; continue; }
    if (char === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = text.indexOf(run, index + run.length);
      if (end > 0 && text[end + run.length] !== "`") {
        const body = text.slice(index + run.length, end);
        push({ ...style, code: true, text: /^ .* $/.test(body) ? body.slice(1, -1) : body });
        index = end + run.length;
        continue;
      }
      plain += run;
      index += run.length;
      continue;
    }
    const strong = /^(\*\*|__|~~)/.exec(rest)?.[1];
    if (strong && flanked(text, index, 2)) {
      const end = text.indexOf(strong, index + 2);
      if (end > index + 2 && !/\s/.test(text[end - 1])) {
        push(...parseInline(text.slice(index + 2, end), { ...style, ...(strong === "~~" ? { strike: true } : { bold: true }) }));
        index = end + 2;
        continue;
      }
    }
    if ((char === "*" || char === "_") && text[index + 1] !== char && flanked(text, index, 1) && !(char === "_" && /\w/.test(text[index - 1] ?? ""))) {
      let end = index + 1;
      while ((end = text.indexOf(char, end)) > 0 && (text[end + 1] === char || /\s/.test(text[end - 1]) || (char === "_" && /\w/.test(text[end + 1] ?? ""))))
        end += text[end + 1] === char ? 2 : 1;
      if (end > index + 1) {
        push(...parseInline(text.slice(index + 1, end), { ...style, italic: true }));
        index = end + 1;
        continue;
      }
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      push(...parseInline(link[1], { ...style, link: link[2] }));
      index += link[0].length;
      continue;
    }
    const auto = /^<(https?:\/\/[^>\s]+)>/.exec(rest) ?? (/[\s(]|^$/.test(text[index - 1] ?? "") ? /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/.exec(rest) : null);
    if (auto) {
      push({ ...style, link: auto[1], text: auto[1] });
      index += auto[0].length;
      continue;
    }
    plain += char;
    index++;
  }
  push();
  return merge(spans);
}

export const plainText = (text: string) => parseInline(text).map((span) => span.text).join("");

/** Length of the prefix made of finished blocks: up to the last blank line or closing fence outside a code fence. */
export function stableLength(text: string) {
  let fence: string | undefined;
  let offset = 0;
  let cut = 0;
  let seen = false;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index];
    offset += line.length + 1;
    if (fence) {
      if (closes(line, fence)) { fence = undefined; cut = offset; }
      continue;
    }
    const open = FENCE.exec(line);
    if (open) fence = open[1];
    else if (line.trim()) seen = true;
    else if (seen) cut = offset;
  }
  return cut;
}

/** The last `count` lines of `text`, reopening a code fence that the cut would leave unopened. */
export function tailLines(text: string, count: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= count) return { text, hidden: 0 };
  const hidden = lines.length - count;
  let fence: string | undefined;
  for (const line of lines.slice(0, hidden)) {
    if (fence) { if (closes(line, fence.match(/[`~]+/)![0])) fence = undefined; } else if (FENCE.test(line)) fence = line;
  }
  return { text: [...fence ? [fence] : [], ...lines.slice(hidden)].join("\n"), hidden };
}
