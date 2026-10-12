import type { Params } from "@oxbit/agent-core";

/** An ACP `session/update` payload: `{sessionUpdate: "agent_message_chunk", ...}`. */
export type SessionUpdate = Params & { sessionUpdate: string };

export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

/** The `session/new` and `session/load` result of the core Agent. */
export interface SessionState {
  sessionId: string;
  models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] };
  modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] };
  configOptions?: ConfigOption[];
}

export interface SessionSummary {
  sessionId: string;
  title?: string;
  updatedAt?: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/** `session/request_permission` params. */
export interface PermissionRequest {
  sessionId: string;
  options: PermissionOption[];
  toolCall: { toolCallId: string; title?: string; kind?: string; status?: string; rawInput?: unknown; content?: Params[] };
}

export type PermissionOutcome = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };

export interface ConnectionInfo {
  /** Provider label for the status line, e.g. "openai". */
  provider?: string;
  /** True when requests use the signed-in ChatGPT subscription. */
  usingChatGPTPlan?: boolean;
}

export type PromptBlock = { type: "text"; text: string };

/** What the TUI needs from W4's in-memory ACP connection. Method names follow ACP. */
export interface TuiConnection {
  info(): ConnectionInfo;
  newSession(cwd: string): Promise<SessionState>;
  loadSession(sessionId: string, cwd: string): Promise<SessionState>;
  listSessions?(cwd: string): Promise<SessionSummary[]>;
  prompt(sessionId: string, prompt: PromptBlock[]): Promise<{ stopReason: string }>;
  cancel(sessionId: string): void | Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<unknown>;
  setModel(sessionId: string, modelId: string): Promise<{ configOptions?: ConfigOption[] } | void>;
  setConfigOption?(sessionId: string, configId: string, value: string): Promise<{ configOptions?: ConfigOption[] } | void>;
  /** Subscribes to `session/update` notifications; returns the unsubscribe function. */
  onUpdate(listener: (sessionId: string, update: SessionUpdate) => void): () => void;
  /** Installs the `session/request_permission` handler; returns the uninstall function. */
  onPermission(handler: (request: PermissionRequest) => Promise<PermissionOutcome>): () => void;
  /** Workspace-relative file paths matching `query` for @ mentions. */
  listFiles?(query: string, cwd: string): Promise<string[]>;
}
