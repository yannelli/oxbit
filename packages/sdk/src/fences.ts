import type { LanguageDefinition } from "./index.js";
import { languages } from "./languages.js";

/** A fenced code block in a Markdown file or in a comment, with the host offsets of each content line. */
export interface CodeFence {
  index: number;
  info: string;
  language: LanguageDefinition;
  /** Host offset of the opening fence line. */
  from: number;
  /** Host offset after the closing fence line, or the end of the text for an unclosed fence. */
  to: number;
  lines: { from: number; to: number }[];
}

const FENCE_ALIASES: Record<string, string> = { shell: "shellscript", console: "shellscript", docker: "dockerfile", jsonc: "jsonc", json5: "jsonc", yml: "yaml", py: "python", md: "markdown" };
const MARKDOWN_HOSTS = new Set(["markdown", "mdx"]);
const COMMENT_MARKER = /\/\/|#|--|\*|;/;
const OPENING = /^([ \t]*(?:(?:\/\/[/!]?|#|--|;+|\*|>)[ \t]*)*)(`{3,}|~{3,})[ \t]*\{?\.?([\w+#.-]*)[^`]*$/;

/** Language for a fence info string such as `ts`, `typescript`, `{.tsx}` or `bash`. */
export function fenceLanguage(info: string, definitions: readonly LanguageDefinition[] = []): LanguageDefinition | undefined {
  const name = info.trim().split(/[\s{},]/).find(Boolean)?.replace(/^\./, "").toLowerCase();
  if (!name) return undefined;
  const id = FENCE_ALIASES[name] ?? name;
  return [...definitions, ...languages].find(item => item.id !== "plaintext" && (item.id === id || item.extensions.some(extension => extension.toLowerCase() === id) || (item as { settingsAliases?: string[] }).settingsAliases?.includes(id) || (item as { title?: string }).title?.toLowerCase() === id));
}

/** Fences in Markdown text, or fences inside comments when the host is another language. */
export function findFences(text: string, hostLanguage: string, definitions: readonly LanguageDefinition[] = []): CodeFence[] {
  const markdown = MARKDOWN_HOSTS.has(hostLanguage), fences: CodeFence[] = [];
  const lines: { from: number; to: number; text: string }[] = [];
  for (let from = 0; from <= text.length;) {
    const end = text.indexOf("\n", from), to = end < 0 ? text.length : end;
    lines.push({ from, to: text[to - 1] === "\r" ? to - 1 : to, text: text.slice(from, text[to - 1] === "\r" ? to - 1 : to) });
    if (end < 0) break;
    from = end + 1;
  }
  for (let row = 0; row < lines.length; row++) {
    const opening = OPENING.exec(lines[row].text);
    if (!opening) continue;
    const [, prefix, marker, info] = opening;
    if (markdown ? /[^ \t>]/.test(prefix) || /^ {4}/.test(prefix) : !COMMENT_MARKER.test(prefix)) continue;
    const language = fenceLanguage(info, definitions);
    const closing = new RegExp(`^[ \\t]*${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
    const content: { from: number; to: number }[] = [];
    let close = row + 1;
    for (; close < lines.length; close++) {
      const line = lines[close], stripped = stripPrefix(line.text, prefix, markdown);
      if (stripped === undefined) break;
      if (closing.test(line.text.slice(stripped))) break;
      content.push({ from: line.from + stripped, to: line.to });
    }
    const closed = close < lines.length && closing.test(lines[close].text.slice(stripPrefix(lines[close].text, prefix, markdown) ?? 0));
    if (language) fences.push({ index: fences.length, info, language, from: lines[row].from, to: closed ? lines[close].to : (lines[close - 1] ?? lines[row]).to, lines: content });
    row = closed ? close : close - 1;
  }
  return fences;
}

/** Length of the host prefix on a content line, or undefined when the line leaves the comment or quote. */
function stripPrefix(line: string, prefix: string, markdown: boolean): number | undefined {
  if (markdown && !prefix.includes(">")) {
    let length = 0;
    while (length < prefix.length && line[length] === " ") length++;
    return length;
  }
  if (line.startsWith(prefix)) return prefix.length;
  const trimmed = prefix.trimEnd();
  if (line.trimEnd() === trimmed) return line.length;
  return undefined;
}

export function fenceText(text: string, fence: CodeFence): string {
  return fence.lines.map(line => text.slice(line.from, line.to)).join("\n");
}

/** Fence offset for a host offset inside the fence content, or undefined outside it. */
export function toFenceOffset(fence: CodeFence, offset: number): number | undefined {
  let base = 0;
  for (const line of fence.lines) {
    if (offset >= line.from && offset <= line.to) return base + offset - line.from;
    base += line.to - line.from + 1;
  }
  return undefined;
}

/** Host offset for a fence offset. Offsets past the end clamp to the last content character. */
export function fromFenceOffset(fence: CodeFence, offset: number): number {
  let base = 0;
  for (const line of fence.lines) {
    if (offset <= base + line.to - line.from) return line.from + Math.max(0, offset - base);
    base += line.to - line.from + 1;
  }
  return fence.lines.at(-1)?.to ?? fence.from;
}

const FENCE_PATH = /\.fence-(\d+)\.[^./]+$/;

/** Sibling path for the fence's virtual document, so imports resolve as they do from the host file. */
export function fencePath(hostPath: string, fence: CodeFence): string {
  return `${hostPath}.fence-${fence.index}.${fence.language.extensions[0] ?? "txt"}`;
}

export function fenceHostPath(path: string): string | undefined {
  return FENCE_PATH.test(path) ? path.replace(FENCE_PATH, "") : undefined;
}
