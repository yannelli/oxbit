import { estimateTokens } from "./compaction.js";
import type { AgentHost } from "./host.js";
import { builtinTools } from "./tools.js";
import { PromptTurn, basePrompt, type LiveSession } from "./turn.js";

export interface ContextCategory { id: string; label: string; tokens: number }
/** The /context breakdown, sent as `_meta.oxbit.context`. */
export interface ContextUsage {
  model: string;
  /** Category counts are estimates at 4 characters per token. */
  estimated: true;
  categories: ContextCategory[];
  /** Sum of the category estimates. */
  used: number;
  window?: number;
  maxOutput?: number;
  /** Tokens at which auto compaction runs. Absent when the window is unknown or auto compaction is off. */
  threshold?: number;
  /** Tokens left before the threshold, or before the end of the window without one. */
  free?: number;
  /** Tokens from the threshold to the end of the window that the conversation does not use. */
  buffer?: number;
  /** Provider-reported input and output tokens of the last request. */
  reported?: { input: number; output: number };
}

const estimate = (text: string) => Math.ceil(text.length / 4);
const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";

/** Estimates what the next request sends: system prompt sections, tool specs and turns. */
export async function contextUsage(host: AgentHost, session: LiveSession, signal: AbortSignal): Promise<ContextUsage> {
  const providers = host.extensions?.context ?? [];
  const sections = await Promise.all(providers.map((provider) => provider.system(session)));
  const labeled = new Map<string, ContextCategory>();
  let other = session.context.reduce((sum, text) => sum + estimate(text), 0);
  providers.forEach((provider, index) => {
    const tokens = estimate(sections[index] ?? "");
    if (!provider.label) {
      other += tokens;
      return;
    }
    const category = labeled.get(provider.label) ?? { id: slug(provider.label), label: provider.label, tokens: 0 };
    category.tokens += tokens;
    labeled.set(provider.label, category);
  });
  const builtin = new Set(builtinTools(host.capabilities).map((tool) => tool.spec.name));
  const tools = await new PromptTurn(host, session, signal).tools();
  const specs = (inside: boolean) => tools.filter((tool) => builtin.has(tool.spec.name) === inside)
    .reduce((sum, tool) => sum + estimate(JSON.stringify(tool.spec)), 0);
  const categories: ContextCategory[] = [
    { id: "system", label: "System prompt", tokens: estimate(basePrompt(session.cwd, host.capabilities.fs, host.capabilities.terminal)) },
    ...labeled.values(),
    { id: "context", label: "Other context", tokens: other },
    { id: "tools", label: "Built-in tools", tokens: specs(true) },
    { id: "mcp", label: "MCP and extension tools", tokens: specs(false) },
    { id: "messages", label: "Messages", tokens: estimateTokens(session.turns) },
  ];
  const used = categories.reduce((sum, category) => sum + category.tokens, 0);
  const info = session.catalog.find((model) => model.id === session.model);
  const window = info?.contextWindow;
  const threshold = window ? host.extensions?.compactor?.autoThreshold?.(window, info?.maxOutput) : undefined;
  return {
    model: session.model, estimated: true, categories, used,
    ...window ? { window, free: Math.max(0, (threshold ?? window) - used) } : {},
    ...info?.maxOutput ? { maxOutput: info.maxOutput } : {},
    ...window && threshold !== undefined ? { threshold, buffer: Math.max(0, window - Math.max(threshold, used)) } : {},
    ...session.usage ? { reported: { ...session.usage } } : {},
  };
}

/** Category ids per cell, then "free" cells and "buffer" cells past the threshold. A non-empty category gets at least one cell. */
export function contextGrid(usage: ContextUsage, cells = 200): string[] {
  if (!usage.window) return [];
  const scale = cells / Math.max(usage.window, usage.used);
  const grid: string[] = [];
  let sum = 0;
  for (const category of usage.categories) {
    sum += category.tokens;
    const end = Math.min(cells, Math.max(Math.round(sum * scale), category.tokens ? grid.length + 1 : grid.length));
    while (grid.length < end) grid.push(category.id);
  }
  const buffer = usage.threshold === undefined ? cells : Math.max(grid.length, Math.round(usage.threshold * scale));
  while (grid.length < buffer) grid.push("free");
  while (grid.length < cells) grid.push("buffer");
  return grid;
}

/** 950, 23.7k, 200k, 1.05M. */
export const formatTokens = (tokens: number) => tokens < 1000 ? String(tokens)
  : tokens < 1e6 ? `${+(tokens / 1000).toFixed(1)}k` : `${+(tokens / 1e6).toFixed(2)}M`;
export const formatPercent = (tokens: number, window: number) => `${(tokens / window * 100).toFixed(1)}%`;

/** The last request's provider-reported size against the window, appended to the next prompt so the model can see it. */
export function usageNote(host: AgentHost, session: LiveSession) {
  const info = session.catalog.find((model) => model.id === session.model);
  const window = info?.contextWindow;
  if (!session.usage || !window) return "";
  const used = session.usage.input + session.usage.output;
  const threshold = host.extensions?.compactor?.autoThreshold?.(window, info?.maxOutput);
  const compaction = threshold === undefined ? "Auto compaction is off." : `Auto compaction runs at ${threshold.toLocaleString("en-US")} tokens.`;
  return `\n\n<context-usage>The last request used ${used.toLocaleString("en-US")} of ${window.toLocaleString("en-US")} context tokens (${Math.round(used / window * 100)}%). ${compaction}</context-usage>`;
}
