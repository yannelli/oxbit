import type { Setting } from "@oxbit/sdk";

export const AI_SETTINGS = {
  inlineCompletions: "ai.inlineCompletions.enabled",
  delay: "ai.inlineCompletions.delay",
  model: "ai.model",
  effort: "ai.effort",
} as const;

export const aiConfiguration: Setting[] = [
  {
    id: AI_SETTINGS.inlineCompletions,
    title: "AI inline completions",
    description: "Suggest code as ghost text while typing. Tab accepts, Escape dismisses, and Ctrl/Cmd+Right accepts one word. Each request sends the code around the cursor to the model provider.",
    category: "Editor · AI",
    type: "boolean",
    default: false,
  },
  {
    id: AI_SETTINGS.delay,
    title: "Inline completion delay",
    description: "Milliseconds after the last keystroke before a suggestion is requested.",
    category: "Editor · AI",
    type: "number",
    default: 350,
    min: 100,
    max: 3000,
  },
  {
    id: AI_SETTINGS.model,
    title: "AI model",
    description: "Model ID for inline completions and inline edits. Empty uses the Oxbit agent's model; a small, fast model keeps suggestions quick.",
    category: "Editor · AI",
    type: "string",
    default: "",
  },
  {
    id: AI_SETTINGS.effort,
    title: "AI reasoning effort",
    description: "Reasoning level sent with AI editor requests, for example minimal or low. Empty sends no level.",
    category: "Editor · AI",
    type: "string",
    default: "",
  },
];
