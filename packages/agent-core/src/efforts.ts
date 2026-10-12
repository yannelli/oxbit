import type { AgentModelApi } from "@oxbit/sdk";
import type { Effort, ModelInfo } from "./model.js";

const ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const LABELS: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
/** Levels for a model whose list entry and family table say nothing. */
export const UNKNOWN_EFFORTS: readonly Effort[] = ["low", "medium", "high"];

const FIVE = ["low", "medium", "high", "xhigh", "max"];
const NONE_TO_MAX = ["none", ...FIVE];
const NONE_TO_XHIGH = ["none", "low", "medium", "high", "xhigh"];
/** Responses `reasoning.effort` by model ID prefix, from the developers.openai.com model pages on 2026-10-12.
 * gpt-5.6 is from openai/codex models.json; the API docs list no levels for it. */
const OPENAI: [string, Effort[]][] = [
  ["gpt-6-astra", FIVE], ["gpt-6.1-sol", FIVE], ["gpt-6-sol", NONE_TO_MAX], ["gpt-6-luna", NONE_TO_MAX], ["gpt-5.6", FIVE],
  ["gpt-5.5", NONE_TO_XHIGH], ["gpt-5.4", NONE_TO_XHIGH], ["gpt-5.2", NONE_TO_XHIGH], ["gpt-5.1", ["none", "low", "medium", "high"]],
  ["gpt-5", ["minimal", "low", "medium", "high"]],
  ["gpt-4", []], ["gpt-4o", []], ["gpt-4.1", []], ["gpt-4.5", []], ["gpt-3.5", []], ["chatgpt-4o", []],
];
/** Messages `output_config.effort` by model ID prefix, from platform.claude.com/docs/en/build-with-claude/effort on 2026-10-12.
 * A longer ID comes before its prefix: claude-opus-5-5 before claude-opus-5. */
const ANTHROPIC: [string, Effort[]][] = [
  ["claude-fable-5-1", FIVE], ["claude-mythos-5-1", FIVE], ["claude-fable-5", FIVE], ["claude-mythos-5", FIVE],
  ["claude-opus-5-5", FIVE], ["claude-sonnet-5-5", FIVE], ["claude-haiku-5-5", FIVE],
  ["claude-opus-5", FIVE], ["claude-sonnet-5", FIVE], ["claude-opus-4-8", FIVE], ["claude-opus-4-7", FIVE],
  ["claude-mythos-preview", ["low", "medium", "high", "max"]], ["claude-opus-4-6", ["low", "medium", "high", "max"]],
  ["claude-sonnet-4-6", ["low", "medium", "high", "max"]], ["claude-opus-4-5", ["low", "medium", "high"]],
];
/** Codex client aliases: the client turns `ultra` into another level plus task delegation and sends `persistent` as `disabled`. */
const CODEX_CLIENT = new Set(["ultra", "persistent"]);

const family = (table: [string, Effort[]][], id: string) =>
  table.find(([prefix]) => id === prefix || id.startsWith(`${prefix}-`))?.[1];
const rank = (level: Effort) => ORDER.indexOf(level) + 1 || ORDER.length + 1;
const sorted = (levels: Effort[]) => [...new Set(levels)].sort((a, b) => rank(a) - rank(b));

export const effortLabel = (level: Effort) => LABELS[level] ?? level.charAt(0).toUpperCase() + level.slice(1);

/** Reasoning levels the model accepts, lowest first: the model list's own, else the API's family table, else UNKNOWN_EFFORTS.
 * Anthropic models outside the table have no effort parameter. */
export function modelEfforts(api: AgentModelApi, model: ModelInfo): Effort[] {
  if (model.efforts) return [...model.efforts];
  const id = model.id.toLowerCase();
  if (api === "anthropic") return [...family(ANTHROPIC, id) ?? []];
  if (api === "openai" || api === "chatgpt") return [...family(OPENAI, id) ?? UNKNOWN_EFFORTS];
  return [...UNKNOWN_EFFORTS];
}

/** Levels from one model list entry, or undefined when the entry has no level fields:
 * Anthropic `capabilities.effort`, OpenRouter `reasoning` and `supported_parameters`, Codex `supported_reasoning_levels`. */
export function listedEfforts(item: any): Effort[] | undefined {
  const effort = item?.capabilities?.effort;
  if (effort && typeof effort === "object")
    return effort.supported === false ? [] : FIVE.filter((level) => effort[level]?.supported === true);
  if (Array.isArray(item?.supported_reasoning_levels))
    return sorted(item.supported_reasoning_levels.map((preset: any) => preset?.effort)
      .filter((level: unknown): level is string => typeof level === "string" && !!level && !CODEX_CLIENT.has(level)));
  const reasoning = item?.reasoning;
  if (reasoning && typeof reasoning === "object") {
    const levels: Effort[] = Array.isArray(reasoning.supported_efforts)
      ? reasoning.supported_efforts.filter((level: unknown): level is string => typeof level === "string" && !!level) : ORDER;
    return sorted(reasoning.mandatory ? levels.filter((level) => level !== "none") : levels);
  }
  if (Array.isArray(item?.supported_parameters))
    return item.supported_parameters.some((name: unknown) => name === "reasoning" || name === "reasoning_effort") ? undefined : [];
  return undefined;
}
