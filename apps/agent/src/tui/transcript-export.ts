import type { Item } from "./transcript.js";

type Assistant = Extract<Item, { type: "assistant" }>;

/** Joins assistant items; a `part` continues the previous item's text. */
const joined = (items: Assistant[]) => items.reduce((text, item) => item.part || !text ? text + item.text : `${text.trimEnd()}\n\n${item.text}`, "").trim();

/** The agent's text after the user message it answers, or undefined before the first reply. */
export function lastReply(items: Item[]): string | undefined {
  const end = items.findLastIndex((item) => item.type === "assistant" && item.text.trim());
  if (end < 0) return undefined;
  const start = items.slice(0, end).findLastIndex((item) => item.type === "user") + 1;
  return joined(items.slice(start, end + 1).filter((item): item is Assistant => item.type === "assistant")) || undefined;
}

/** User and agent messages with tool call titles and statuses, as Markdown. */
export function toMarkdown(items: Item[], title?: string, sessionId?: string): string {
  const blocks = [`# ${title || "Oxbit Agent session"}`, ...sessionId ? [`Session \`${sessionId}\``] : []];
  let reply: Assistant[] = [];
  let agent = false;
  const close = () => {
    const text = joined(reply);
    if (text) blocks.push(text);
    reply = [];
  };
  for (const item of items) {
    if (item.type === "user") {
      close();
      agent = false;
      blocks.push(item.continuation ? "## User (continuation)" : "## User", item.text.trim());
      continue;
    }
    if (item.type !== "assistant" && item.type !== "tool") continue;
    if (!agent) blocks.push("## Agent");
    agent = true;
    if (item.type === "assistant") {
      if (!item.part) close();
      reply.push(item);
    } else {
      close();
      blocks.push(`- Tool: ${item.tool.title} (${item.tool.status})`);
    }
  }
  close();
  return `${blocks.join("\n\n")}\n`;
}

export const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
export const oscTitle = (title: string) => `\x1b]2;${title.replace(/[\x00-\x1f\x7f]/g, " ")}\x07`;
export const windowTitle = (title: string | undefined, running: boolean) => `${running ? "● " : ""}${title || "Oxbit Agent"}`;
