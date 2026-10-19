import type { Text } from "@codemirror/state";

export const CURSOR = "<|cursor|>";
export const PREFIX_CHARS = 6000;
export const SUFFIX_CHARS = 2000;
export const CHARS_PER_TOKEN = 4;
const MAX_COMPLETION_LINES = 24;
const OPEN_FILE_LIMIT = 3;
const PROBLEM_LIMIT = 20;

export interface CompletionContext {
  path: string;
  language?: string;
  prefix: string;
  suffix: string;
}
export interface CompletionPromptContext extends CompletionContext {
  includePath?: boolean;
  problems?: string[];
  openFiles?: OpenFile[];
}
export interface OpenFile {
  path: string;
  text: string;
}
export interface ContextLimits {
  linesBefore: number;
  linesAfter: number;
  tokens: number;
}
export interface EditContext extends CompletionContext {
  selection: string;
  instruction: string;
}

export const COMPLETION_SYSTEM = [
  "You are a code completion engine inside an editor.",
  `The user's file contains ${CURSOR} where the cursor is.`,
  "Reply with only the text to insert at the cursor: no explanation, no Markdown, no code fences.",
  "Do not repeat code that is already before or after the cursor. Reply with nothing when no completion fits.",
].join(" ");

export const EDIT_SYSTEM = [
  "You are a code editor. Rewrite the selected code as the instruction asks.",
  "Reply with only the replacement for the selection: no explanation, no Markdown, no code fences.",
  "Keep the indentation and style of the surrounding code. When the selection is empty, reply with code to insert at the cursor.",
].join(" ");

const header = ({ path, language }: CompletionContext) => `Path: ${path}${language ? `\nLanguage: ${language}` : ""}`;

export function completionSystem({ maxLines, instructions }: { maxLines: number; instructions?: string }) {
  const lines = `${COMPLETION_SYSTEM} ${maxLines === 1 ? "Complete only the rest of the current line." : `Reply with at most ${maxLines} lines.`}`;
  return instructions?.trim() ? `${lines}\n\nInstructions from the user:\n${instructions.trim()}` : lines;
}

export function completionPrompt(context: CompletionPromptContext) {
  const sections = context.includePath === false ? [] : [header(context)];
  for (const file of context.openFiles ?? []) sections.push(`Open file ${file.path}:\n<file>${file.text}</file>`);
  if (context.problems?.length) sections.push(`Problems in this code:\n${context.problems.join("\n")}`);
  sections.push(`${context.prefix}${CURSOR}${context.suffix}`);
  return sections.join("\n\n");
}

/** The last `length` characters of `text`, starting at a line start when one falls inside them. */
function keepEnd(text: string, length: number) {
  if (text.length <= length) return text;
  const cut = text.slice(text.length - Math.max(0, length)), newline = cut.indexOf("\n");
  return newline >= 0 ? cut.slice(newline + 1) : cut;
}

/** The first `length` characters of `text`, ending at a line end when one falls inside them. */
function keepStart(text: string, length: number) {
  if (text.length <= length) return text;
  const cut = text.slice(0, Math.max(0, length)), newline = cut.lastIndexOf("\n");
  return newline > 0 ? cut.slice(0, newline) : cut;
}

/** The code around `pos` within the line limits and the token budget. The suffix keeps at least a quarter of the budget; lines farthest from the cursor go first. */
export function contextWindow(doc: Text, pos: number, { linesBefore, linesAfter, tokens }: ContextLimits) {
  const line = doc.lineAt(pos), budget = tokens * CHARS_PER_TOKEN;
  const from = doc.line(Math.max(1, line.number - linesBefore)).from, to = doc.line(Math.min(doc.lines, line.number + linesAfter)).to;
  const before = doc.sliceString(from, pos), after = doc.sliceString(pos, to);
  const suffix = keepStart(after, Math.max(budget - before.length, Math.floor(budget / 4)));
  const prefix = keepEnd(before, budget - suffix.length);
  return { prefix, suffix, firstLine: doc.lineAt(pos - prefix.length).number, lastLine: doc.lineAt(pos + suffix.length).number };
}

/** Errors and warnings from LSP diagnostics on lines `firstLine` to `lastLine` (1-based), as `Line N (error): message`. */
export function nearbyProblems(diagnostics: unknown[], firstLine: number, lastLine: number) {
  const problems: string[] = [];
  for (const item of diagnostics as { range?: { start?: { line?: number } }; severity?: number; message?: unknown }[]) {
    const line = (item?.range?.start?.line ?? -1) + 1, severity = item?.severity ?? 1;
    if (line < firstLine || line > lastLine || severity > 2 || typeof item.message !== "string") continue;
    problems.push(`Line ${line} (${severity === 1 ? "error" : "warning"}): ${item.message.split("\n")[0]}`);
    if (problems.length === PROBLEM_LIMIT) break;
  }
  return problems;
}

/** The start of up to 3 files, sharing `tokens` evenly. */
export function openFileContext(files: OpenFile[], tokens: number): OpenFile[] {
  const chosen = files.filter((file) => file.text.trim()).slice(0, OPEN_FILE_LIMIT);
  const share = Math.floor(tokens * CHARS_PER_TOKEN / Math.max(1, chosen.length));
  return chosen.map((file) => ({ path: file.path, text: keepStart(file.text, share) })).filter((file) => file.text.trim());
}

export function editPrompt(context: EditContext) {
  return [
    header(context),
    `Code before the selection:\n<before>${context.prefix}</before>`,
    `Selection:\n<selection>${context.selection}</selection>`,
    `Code after the selection:\n<after>${context.suffix}</after>`,
    `Instruction: ${context.instruction}`,
  ].join("\n\n");
}

/** Removes one Markdown fence around the whole reply, and the given wrapper tags. */
export function unwrap(text: string, tags: string[] = []) {
  let result = text.replace(/^\s*```[\w+#.-]*[^\S\n]*\n([\s\S]*?)\n?```\s*$/, "$1");
  for (const tag of tags) result = result.replace(new RegExp(`^\\s*<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>\\s*$`), "$1");
  return result;
}

/** The length of the current line's text when the reply starts by repeating it. */
function repeatedLine(text: string, before: string) {
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if (line.trim() && text.startsWith(line)) return line.length;
  const trimmed = line.trimStart();
  return trimmed && text.startsWith(trimmed) ? trimmed.length : 0;
}

/** The longest start of `after` that ends `text`, limited to the rest of the current line. */
function repeatedSuffix(text: string, after: string) {
  const end = after.indexOf("\n");
  const rest = end < 0 ? after : after.slice(0, end);
  for (let length = Math.min(rest.length, text.length); length > 0; length--)
    if (text.endsWith(rest.slice(0, length)) && rest.slice(0, length).trim()) return length;
  return 0;
}

/** The text to show as ghost text, or "" when the reply holds no usable completion. */
export function cleanCompletion(reply: string, context: Pick<CompletionContext, "prefix" | "suffix">, maxLines = MAX_COMPLETION_LINES) {
  let text = unwrap(reply).replace(/\r\n/g, "\n");
  const marker = text.indexOf(CURSOR);
  if (marker >= 0) text = text.slice(marker + CURSOR.length);
  text = text.slice(repeatedLine(text, context.prefix));
  text = text.slice(0, text.length - repeatedSuffix(text, context.suffix));
  text = text.split("\n").slice(0, maxLines).join("\n").replace(/\s+$/, "");
  if (!text.trim() || context.suffix.startsWith(text)) return "";
  return text;
}

/** The replacement for the selection, keeping whether the selection ended with a newline. */
export function cleanEdit(reply: string, selection: string) {
  let text = unwrap(reply.replace(/\r\n/g, "\n"), ["selection"]);
  const newline = selection.endsWith("\n");
  if (newline && !text.endsWith("\n")) text += "\n";
  if (!newline) text = text.replace(/\n+$/, "");
  return text;
}
