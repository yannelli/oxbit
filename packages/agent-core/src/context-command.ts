import { contextGrid, contextUsage, formatPercent, formatTokens, type ContextUsage } from "./context-usage.js";
import type { AgentCommand } from "./extensions.js";
import type { AgentHost } from "./host.js";
import type { LiveSession } from "./turn.js";

const COLUMNS = 20;
const GLYPHS: Record<string, string> = { system: "#", instructions: "=", skills: "+", context: "~", tools: "*", mcp: "%", messages: "@",
  free: ".", buffer: "x" };
const SPARE = ["&", "$", "o", "^"];

/** Legend rows of the text and TUI views: categories, then free space and the auto-compact buffer when the window is known. */
export function contextLegend(usage: ContextUsage) {
  let spare = 0;
  const rows = usage.categories.map((category) => ({ id: category.id, glyph: GLYPHS[category.id] ?? SPARE[spare++ % SPARE.length],
    label: category.label, tokens: category.tokens }));
  if (usage.free !== undefined) rows.push({ id: "free", glyph: GLYPHS.free, label: "Free space", tokens: usage.free });
  if (usage.buffer !== undefined) rows.push({ id: "buffer", glyph: GLYPHS.buffer, label: "Auto-compact buffer", tokens: usage.buffer });
  return rows;
}

/** Header and footer sentences shared by the text and TUI views. */
export function contextNotes(usage: ContextUsage) {
  const model = usage.model || "no model";
  const header = usage.window ? `Context usage for ${model}: ${formatTokens(usage.used)} of ${formatTokens(usage.window)} tokens (${formatPercent(usage.used, usage.window)}).`
    : `Context usage for ${model}: about ${formatTokens(usage.used)} tokens. The context window of this model is unknown.`;
  const footer = [
    ...usage.window ? [usage.threshold === undefined ? "Auto compaction is off."
      : `Auto compaction runs at ${formatTokens(usage.threshold)} tokens (${formatPercent(usage.threshold, usage.window)}).`] : [],
    ...usage.reported ? [`Provider count for the last request: ${formatTokens(usage.reported.input + usage.reported.output)} tokens `
      + `(${formatTokens(usage.reported.input)} input, ${formatTokens(usage.reported.output)} output).`] : [],
    "Category counts are estimates at 4 characters per token.",
  ];
  return { header, footer };
}

/** Markdown with a fenced grid and legend, so ACP clients keep the columns aligned. */
export function renderContextUsage(usage: ContextUsage) {
  const legend = contextLegend(usage);
  const glyphs = new Map(legend.map((row) => [row.id, row.glyph]));
  const grid = contextGrid(usage);
  const rows: string[] = [];
  for (let index = 0; index < grid.length; index += COLUMNS) rows.push(grid.slice(index, index + COLUMNS).map((id) => glyphs.get(id)).join(" "));
  const width = Math.max(...legend.map((row) => row.label.length));
  const counts = legend.map((row) => formatTokens(row.tokens));
  const digits = Math.max(...counts.map((count) => count.length));
  const lines = legend.map((row, index) => `${row.glyph} ${row.label.padEnd(width)}  ${counts[index].padStart(digits)}`
    + (usage.window ? `  ${formatPercent(row.tokens, usage.window).padStart(6)}` : ""));
  const { header, footer } = contextNotes(usage);
  return [header, "", "```text", ...rows.length ? [...rows, ""] : [], ...lines, "```", "", footer.join(" ")].join("\n");
}

/** `/context`: the context window breakdown as text, with the structured breakdown in `_meta.oxbit.context`. */
export function contextCommand(host: AgentHost, session: LiveSession): AgentCommand {
  return {
    name: "context", description: "Show context window usage",
    run: async (_args, context) => {
      const usage = await contextUsage(host, session, context.signal);
      context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: renderContextUsage(usage) }, _meta: { oxbit: { context: usage } } });
      return { done: "end_turn" };
    },
  };
}
