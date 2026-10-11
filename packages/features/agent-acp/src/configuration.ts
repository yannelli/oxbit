import {
  ACP_CUSTOM_PROVIDER,
  ACP_PROVIDERS,
  OXBIT_AGENT_SETTINGS,
  type AgentModelApi,
  type AgentModelEndpoint,
  type Setting,
} from "@oxbit/sdk";

export const settingId = (provider: string, key: string) =>
  `agentACP.${provider}.${key}`;

type Configuration = { get<T>(id: string): T | undefined } | undefined;

/** The Oxbit agent's endpoint from settings. `baseUrl` applies to `openai-compatible` only. */
export function oxbitEndpoint(config: Configuration): AgentModelEndpoint {
  const api = config?.get<AgentModelApi>(OXBIT_AGENT_SETTINGS.api) || "openai";
  if (api !== "openai-compatible") return { api };
  return { api, baseUrl: config?.get<string>(OXBIT_AGENT_SETTINGS.baseUrl)?.trim() ?? "" };
}
export const agentConfiguration: Setting[] = [
  {
    id: "agentACP.provider",
    title: "Default agent",
    description: "A built-in agent ID, an ACP Registry agent ID, or custom.",
    category: "Agent ACP",
    type: "string",
    default: "codex",
  },
  {
    id: "agentACP.useModifierToSend",
    title: "Send with Ctrl/Cmd+Enter only",
    description: "Enter inserts a new line and Ctrl/Cmd+Enter sends the message.",
    category: "Agent ACP",
    type: "boolean",
    default: false,
  },
  {
    id: "agentACP.notifications",
    title: "Agent desktop notifications",
    description: "Show a system notification when the agent needs input or finishes while Oxbit is in the background.",
    category: "Agent ACP",
    type: "string",
    enum: ["whenHidden", "never"],
    default: "whenHidden",
  },
  ...ACP_PROVIDERS.flatMap((provider) => [
    {
      id: settingId(provider.id, "command"),
      title: `${provider.name} executable`,
      category: "Agent ACP",
      type: "string" as const,
      default: provider.command,
    },
    {
      id: settingId(provider.id, "args"),
      title: `${provider.name} arguments (JSON array)`,
      category: "Agent ACP",
      type: "string" as const,
      default: JSON.stringify(provider.args),
    },
  ]),
  {
    id: settingId(ACP_CUSTOM_PROVIDER, "name"),
    title: "Custom agent name",
    category: "Agent ACP",
    type: "string",
    default: "",
  },
  {
    id: settingId(ACP_CUSTOM_PROVIDER, "command"),
    title: "Custom agent executable",
    category: "Agent ACP",
    type: "string",
    default: "",
  },
  {
    id: settingId(ACP_CUSTOM_PROVIDER, "args"),
    title: "Custom agent arguments (JSON array)",
    category: "Agent ACP",
    type: "string",
    default: "[]",
  },
  {
    id: OXBIT_AGENT_SETTINGS.api,
    title: "Oxbit Agent API",
    description: "openai uses the Responses API, anthropic the Messages API, and openai-compatible Chat Completions at the base URL.",
    category: "Agent ACP",
    type: "string",
    enum: ["openai", "anthropic", "openai-compatible"],
    default: "openai",
  },
  {
    id: OXBIT_AGENT_SETTINGS.baseUrl,
    title: "Oxbit Agent base URL",
    description: "Origin and path prefix for openai-compatible, for example https://openrouter.ai/api.",
    category: "Agent ACP",
    type: "string",
    default: "",
  },
  {
    id: OXBIT_AGENT_SETTINGS.model,
    title: "Oxbit Agent model",
    description: "Model ID for new conversations.",
    category: "Agent ACP",
    type: "string",
    default: "",
  },
];
