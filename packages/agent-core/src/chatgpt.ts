import type { ModelAdapter, ModelInfo } from "./model.js";
import { openaiResponses, responsesBody } from "./openai-responses.js";

/** Codex CLI release rust-v0.172.0 (2026-11-24). The backend leaves out models that need a newer client. */
export const CHATGPT_CLIENT_VERSION = "0.172.0";
export const CHATGPT_MODELS_PATH = `/codex/models?client_version=${CHATGPT_CLIENT_VERSION}`;

const XHIGH = ["low", "medium", "high", "xhigh"];
const MAX = { contextWindow: 272000, efforts: [...XHIGH, "max"] };
const MAX_500K = { ...MAX, contextWindow: 500000 };
/** Picker models by priority from codex-rs/models-manager/models.json in the release above.
 * `efforts` is `supported_reasoning_levels` without `ultra`, which the Codex client resolves to another level. */
export const CHATGPT_MODELS: ModelInfo[] = [
  { id: "gpt-6.2-sol", name: "GPT-6.2-Sol", ...MAX_500K },
  { id: "gpt-6.2-astra", name: "GPT-6.2-Astra", ...MAX },
  { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", ...MAX_500K },
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", ...MAX_500K },
  { id: "gpt-6-astra", name: "GPT-6-Astra", ...MAX },
  { id: "gpt-6-sol", name: "GPT-6-Sol", ...MAX },
  { id: "gpt-6-luna", name: "GPT-6-Luna", ...MAX },
  { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", ...MAX },
  { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", ...MAX },
  { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", ...MAX },
  { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 272000, efforts: XHIGH },
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
