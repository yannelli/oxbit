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
    sessionCapabilities?: {
      list?: object;
      resume?: object;
      subagents?: object;
    };
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

export type ACPSubagentState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "disconnected"
  | "unknown";
export type ACPSubagentPhase =
  "unknown" | "thinking" | "executing_tools" | "responding" | "awaiting_input";
/** Bounded display data. These records never authorize a session or a tool. */
export interface ACPSubagentActivity {
  id: string;
  kind: "message" | "tool" | "terminal" | "notice";
  role?: "agent" | "user" | "thought";
  text?: string;
  title?: string;
  status?: string;
  input?: string;
  output?: string;
  locations?: { path: string; line?: number }[];
}
export interface ACPSubagent {
  id: string;
  parentId?: string;
  rootSessionId: string;
  sessionId?: string;
  provider: ACPProviderId;
  providerId?: string;
  toolCallIds: string[];
  name: string;
  task: string;
  model?: string;
  state: ACPSubagentState;
  phase: ACPSubagentPhase;
  evidence: "native" | "provider" | "tool";
  visibility: "full" | "limited";
  /** Stable discovery order, preserved when a provisional task gains an agent ID. */
  order?: number;
  observedAt: string;
  updatedAt: string;
  endedAt?: string;
  durationMs?: number;
  result?: string;
  activity: ACPSubagentActivity[];
  truncated?: boolean;
  historical?: boolean;
}
export interface ACPSubagentEvent {
  id: string;
  rootSessionId: string;
  subagent: ACPSubagent;
  activeCount: number;
  removedIds: string[];
  truncated: boolean;
}
