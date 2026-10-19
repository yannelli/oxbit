export type InlineModelCatalog = "openrouter" | "openai" | "anthropic" | "local";
export interface InlineModel {
  id: string;
  label: string;
  /** Price, context and one sourced benchmark score; see docs/ai-inline-models.md. */
  detail?: string;
}

export const INLINE_MODELS: Record<InlineModelCatalog, InlineModel[]> = {
  openrouter: [],
  openai: [],
  anthropic: [],
  local: [],
};
