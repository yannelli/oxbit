export type InlineModelCatalog = "openrouter" | "openai" | "anthropic" | "local";
export interface InlineModel {
  id: string;
  label: string;
  /** Price per 1M input/output tokens, context or download size, and one sourced score. Sources: docs/ai-inline-models.md. */
  detail?: string;
}

/** Fast, low-cost models for inline completions, checked 2026-10-19. AA is the Artificial Analysis Intelligence Index v4.3.2 at maximum effort; LCB is Vals AI's LiveCodeBench v6 run of 2026-09-01. */
export const INLINE_MODELS: Record<InlineModelCatalog, InlineModel[]> = {
  openrouter: [
    { id: "inception/mercury-2.5", label: "Mercury 2.5", detail: "$0.04 / $0.15 · 260K context · AA 12" },
    { id: "openai/gpt-6-luna", label: "GPT-6 Luna", detail: "$0.10 / $0.50 · 1M context · AA 38" },
    { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", detail: "$0.10 / $0.50 · 1M context · AA 43" },
    { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", detail: "$0.03 / $0.08 · 1M context · AA 39" },
    { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", detail: "$0.30 / $2.50 · 1M context · LCB 79% · always reasons" },
  ],
  openai: [
    { id: "gpt-6-luna", label: "GPT-6 Luna", detail: "$0.10 / $0.50 · 1M context · AA 38" },
    { id: "gpt-5-nano", label: "GPT-5 nano", detail: "$0.05 / $0.40 · 400K context · LCB 70%" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 nano", detail: "$0.20 / $1.25 · 400K context · LCB 84%" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini", detail: "$0.75 / $4.50 · 400K context · LCB 81%" },
  ],
  anthropic: [
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", detail: "$0.10 / $0.50 · 1M context · AA 43" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", detail: "$2.00 / $10.00 · 1M context · AA 56" },
  ],
  local: [
    { id: "qwen3.6:35b-a3b-coding", label: "Qwen3.6 35B-A3B Coding", detail: "23 GB · 3B active · AA 18" },
    { id: "qwen3.8:27b", label: "Qwen3.8 27B", detail: "18 GB · LCB 84% · AA 34" },
    { id: "gemma4:12b", label: "Gemma 4 12B", detail: "8 GB · AA 14 (estimate)" },
    { id: "qwen3.5:9b", label: "Qwen3.5 9B", detail: "7 GB · AA 11" },
    { id: "laguna-xs-2.1", label: "Laguna XS 2.1", detail: "20 GB · 3B active · SWE-bench Verified 70.9% (vendor)" },
  ],
};
