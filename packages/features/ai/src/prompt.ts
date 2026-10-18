export const CURSOR = "<|cursor|>";
export const PREFIX_CHARS = 6000;
export const SUFFIX_CHARS = 2000;
const MAX_COMPLETION_LINES = 24;

export interface CompletionContext {
  path: string;
  language?: string;
  prefix: string;
  suffix: string;
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

export function completionPrompt(context: CompletionContext) {
  return `${header(context)}\n\n${context.prefix}${CURSOR}${context.suffix}`;
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
export function cleanCompletion(reply: string, context: Pick<CompletionContext, "prefix" | "suffix">) {
  let text = unwrap(reply).replace(/\r\n/g, "\n");
  const marker = text.indexOf(CURSOR);
  if (marker >= 0) text = text.slice(marker + CURSOR.length);
  text = text.slice(repeatedLine(text, context.prefix));
  text = text.slice(0, text.length - repeatedSuffix(text, context.suffix));
  text = text.split("\n").slice(0, MAX_COMPLETION_LINES).join("\n").replace(/\s+$/, "");
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
