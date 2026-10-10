/** ACP launch presets. Downloads happen only when the user connects an agent. */
export const ACP_PROVIDERS = [
  {
    id: "codex",
    name: "Codex ACP",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.2.2"],
    setup:
      "Uses the Codex ACP adapter. Sign in through an advertised authentication method, or use your existing Codex credentials.",
    url: "https://github.com/agentclientprotocol/codex-acp",
    registryId: "codex-acp",
  },
  {
    id: "claude",
    name: "Claude Agent",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.89.1"],
    setup:
      "Uses the Claude Agent ACP adapter. Sign in through an advertised authentication method, or use your existing Claude Code credentials.",
    url: "https://github.com/agentclientprotocol/claude-agent-acp",
    registryId: "claude-acp",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "npx",
    args: ["-y", "@google/gemini-cli@0.63.0", "--acp"],
    setup:
      "Runs Gemini CLI in ACP mode. Sign in through an advertised authentication method, or set GEMINI_API_KEY in the runtime environment.",
    url: "https://github.com/google-gemini/gemini-cli",
    registryId: "gemini",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    command: "npx",
    args: ["-y", "@github/copilot@1.0.95", "--acp"],
    setup:
      "Runs GitHub Copilot CLI in ACP mode. Sign in through an advertised authentication method, or run copilot and use /login first.",
    url: "https://github.com/github/copilot-cli",
    registryId: "github-copilot-cli",
  },
  {
    id: "cursor",
    name: "Cursor ACP",
    command: "agent",
    args: ["acp"],
    setup:
      "Install Cursor CLI and run agent login first. If your executable is cursor-agent, change the command below.",
    url: "https://cursor.com/docs/cli/acp",
    registryId: "cursor",
  },
  {
    id: "amp",
    name: "Amp Agent ACP",
    command: "npx",
    args: ["-y", "amp-acp@0.10.0"],
    setup:
      "Uses the community Amp ACP adapter. Install Amp CLI and run amp login first. Set AMP_CLI_PATH in the runtime environment if needed.",
    url: "https://github.com/tao12345666333/amp-acp",
    registryId: "amp-acp",
  },
] as const;
export type ACPBuiltinProviderId = (typeof ACP_PROVIDERS)[number]["id"];
/** A built-in preset ID, an ACP Registry agent ID, or "custom". */
export type ACPProviderId = string;
export const ACP_CUSTOM_PROVIDER = "custom";
export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
export const acpPreset = (id: string) =>
  ACP_PROVIDERS.find((provider) => provider.id === id);
/** Built-in presets replace the matching registry entries, so subagent tracking keeps its provider ID. */
export const acpBuiltinForRegistry = (registryId: string) =>
  ACP_PROVIDERS.find((provider) => provider.registryId === registryId);
export interface ACPLaunch {
  provider: ACPProviderId;
  command?: string;
  args?: string[];
  /** Display name for a custom agent. */
  name?: string;
  /** The runtime resolves the command from its own copy of the ACP Registry. */
  registry?: { id: string; version?: string };
  clientCapabilities?: { editorTools?: boolean };
}
export type ACPRegistryDistribution = "npx" | "uvx" | "binary";
export interface ACPRegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  license?: string;
  distribution: ACPRegistryDistribution;
  /** False when the runtime cannot launch this entry; `reason` says why. */
  available: boolean;
  reason?: string;
  /** Binary agents only: the pinned version is extracted in the runtime data directory. */
  installed?: boolean;
  /** The built-in preset that replaces this entry. */
  builtin?: ACPBuiltinProviderId;
}
export interface ACPRegistryListing {
  agents: ACPRegistryAgent[];
  fetchedAt: string;
  /** Set when the listing comes from the cache because the registry could not be reached. */
  error?: string;
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
  /** Display name resolved by the runtime. Runtimes from 0.7.1 and earlier omit it. */
  name?: string;
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
    promptCapabilities?: { embeddedContext?: boolean; image?: boolean };
    mcpCapabilities?: { http?: boolean };
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
  /** Workspace path; for images, the pasted file name. */
  path: string;
  /** Snapshot text; for images, a display placeholder. */
  text: string;
  label?: string;
  line?: number;
  endLine?: number;
  version?: number;
  kind?: "file" | "selection" | "diagnostics" | "changes" | "image";
  /** Images only: png, jpeg, gif or webp. */
  mimeType?: string;
  /** Images only: base64 bytes. Saved transcripts omit it. */
  data?: string;
}

export interface ACPQueuedPrompt {
  id: string;
  text: string;
  context?: ACPContext[];
}
export interface ACPLiveSession {
  connection: ACPConnection;
  busy: boolean;
  title: string;
  pendingRequests: number;
  queued: number;
}
export interface ACPSessionSnapshot {
  connection: ACPConnection;
  busy: boolean;
  events: { name: string; params: Record<string, any> }[];
  requests: {
    id: string;
    requestId: string;
    sessionId?: string;
    rootSessionId?: string;
    subagentId?: string;
    method: string;
    params: Record<string, any>;
  }[];
  queue: ACPQueuedPrompt[];
  queuePaused: boolean;
  sequence: number;
  truncated: boolean;
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
