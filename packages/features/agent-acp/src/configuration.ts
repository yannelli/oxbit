import { ACP_CUSTOM_PROVIDER, ACP_PROVIDERS, type Setting } from "@oxbit/sdk";

export const settingId = (provider: string, key: string) =>
  `agentACP.${provider}.${key}`;
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
];
