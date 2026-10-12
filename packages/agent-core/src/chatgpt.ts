import type { ModelAdapter, ModelInfo } from "./model.js";
import { openaiResponses, responsesBody } from "./openai-responses.js";

/** Codex CLI release rust-v0.162.1 (2026-10-09). The backend leaves out models that need a newer client. */
export const CHATGPT_CLIENT_VERSION = "0.162.1";
export const CHATGPT_MODELS_PATH = `/codex/models?client_version=${CHATGPT_CLIENT_VERSION}`;

const WINDOW = { contextWindow: 272000 };
/** Picker models (`visibility: "list"`) by priority, from openai/codex codex-rs/models-manager/models.json at main on 2026-10-12. */
export const CHATGPT_MODELS: ModelInfo[] = [
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", ...WINDOW },
  { id: "gpt-6-astra", name: "GPT-6-Astra", ...WINDOW },
  { id: "gpt-6-sol", name: "GPT-6-Sol", ...WINDOW },
  { id: "gpt-6-luna", name: "GPT-6-Luna", ...WINDOW },
  { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", ...WINDOW },
  { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", ...WINDOW },
  { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", ...WINDOW },
  { id: "gpt-5.5", name: "GPT-5.5", ...WINDOW },
];

/** ChatGPT plan Codex Responses (`api: "chatgpt"`), POST /codex/responses. The backend requires instructions, rejects store: true and max_output_tokens. */
export const chatgptResponses: ModelAdapter = {
  request: (input) => ({
    method: "POST",
    path: "/codex/responses",
    body: {
      ...responsesBody({ ...input, system: input.system || "You are a helpful assistant." }, ["openai", "chatgpt"]),
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
    },
  }),
  events: openaiResponses.events,
};
