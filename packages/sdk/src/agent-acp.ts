/** ACP launch presets. Downloads happen only when the user connects an agent. */
export const ACP_PROVIDERS = [
  {
    id: "codex",
    name: "Codex ACP",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.10.0"],
    setup:
      "Uses the Codex ACP adapter. Sign in through an advertised authentication method, or use your existing Codex credentials.",
    url: "https://github.com/agentclientprotocol/codex-acp",
  },
  {
    id: "cursor",
    name: "Cursor ACP",
    command: "agent",
    args: ["acp"],
    setup:
      "Install Cursor CLI and run agent login first. If your executable is cursor-agent, change the command below.",
    url: "https://cursor.com/docs/cli/acp",
  },
  {
    id: "amp",
    name: "Amp Agent ACP",
    command: "npx",
    args: ["-y", "amp-acp@0.9.0"],
    setup:
      "Uses the community Amp ACP adapter. Install Amp CLI and run amp login first. Set AMP_CLI_PATH in the runtime environment if needed.",
    url: "https://github.com/tao12345666333/amp-acp",
  },
] as const;
export type ACPProviderId = (typeof ACP_PROVIDERS)[number]["id"];
export interface ACPLaunch {
  provider: ACPProviderId;
  command?: string;
  args?: string[];
}
export interface ACPOption {
  id: string;
  name: string;
  description?: string;
}
export interface ACPConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: (
    | { value: string; name: string }
    | { group: string; options: { value: string; name: string }[] }
  )[];
}
export interface ACPConnection {
  id: string;
  provider: ACPProviderId;
  root: string;
  sessionId?: string;
  authMethods: ACPOption[];
  agentInfo?: { name: string; title?: string; version?: string };
  capabilities?: {
    loadSession?: boolean;
    sessionCapabilities?: { list?: object; resume?: object };
    promptCapabilities?: { embeddedContext?: boolean };
  };
  modes?: { currentModeId: string; availableModes: ACPOption[] };
  models?: {
    currentModelId: string;
    availableModels: { modelId: string; name: string }[];
  };
  configOptions?: ACPConfigOption[];
}
export interface ACPSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}
export interface ACPContext {
  path: string;
  text: string;
  label?: string;
  line?: number;
  endLine?: number;
  version?: number;
  kind?: "file" | "selection" | "diagnostics";
}
