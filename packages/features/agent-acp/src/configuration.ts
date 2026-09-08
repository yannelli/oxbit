import { ACP_PROVIDERS, type Setting } from "@oxbit/sdk";

export const settingId = (provider: string, key: string) =>
  `agentACP.${provider}.${key}`;
export const agentConfiguration: Setting[] = [
  {
    id: "agentACP.provider",
    title: "Default agent",
    category: "Agent ACP",
    type: "string",
    default: "codex",
    enum: ACP_PROVIDERS.map((p) => p.id),
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
];
