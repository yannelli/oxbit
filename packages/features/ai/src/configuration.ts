import type { Setting } from "@oxbit/sdk";

export const AI_SETTINGS = {
  inlineCompletions: "ai.inlineCompletions.enabled",
  delay: "ai.inlineCompletions.delay",
  provider: "ai.provider",
  baseUrl: "ai.baseUrl",
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
    id: AI_SETTINGS.provider,
    title: "AI provider",
    description: "Where inline completions and inline edits are sent. agent uses the Oxbit agent's provider and key. openrouter sends to OpenRouter. openai-compatible sends to the Chat Completions API at AI base URL. local sends to Ollama or a llama.cpp server at AI base URL without a key. Run Set AI Provider API Key to save a key for openrouter or openai-compatible.",
    category: "Editor · AI",
    type: "string",
    enum: ["agent", "openrouter", "openai-compatible", "local"],
    enumLabels: ["Agent harness", "OpenRouter", "Custom OpenAI API", "Local model (Ollama or llama.cpp)"],
    default: "agent",
  },
  {
    id: AI_SETTINGS.baseUrl,
    title: "AI base URL",
    description: "Origin and path prefix for the openai-compatible and local providers, for example https://api.example.com, http://127.0.0.1:11434 for Ollama, or http://127.0.0.1:8080 for llama.cpp. Empty uses Ollama on this device for local. On iPhone, use the computer's LAN address, such as http://192.168.1.20:11434.",
    category: "Editor · AI",
    type: "string",
    default: "",
  },
  {
    id: AI_SETTINGS.model,
    title: "AI model",
    description: "Model ID for inline completions and inline edits. With the agent provider, empty uses the Oxbit agent's model. Other providers need a model. A small, fast chat model keeps suggestions quick.",
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
