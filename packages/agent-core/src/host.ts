import type { ACPConfigOption, AgentModelEndpoint, AgentModels, FileSystem } from "@oxbit/sdk";
import type { AgentExtensions, Params, SessionView } from "./extensions.js";
import type { ModelInfo } from "./model.js";

/** Model list with context windows and output limits. */
export type ModelCatalog = ModelInfo[] | Promise<ModelInfo[]>;
export interface HostCapabilities {
  fs: boolean;
  terminal: boolean;
  /** false hides the diagnostics tool when nothing answers oxbit/diagnostics. */
  diagnostics?: boolean;
  /** ACP `mcpCapabilities`: the session/new MCP transports the host connects to besides stdio. */
  mcp?: { http?: boolean; sse?: boolean };
}

export interface AgentHost {
  /** Model transport for the current provider. */
  models(): AgentModels | undefined;
  /** api and baseUrl for the current provider. */
  endpoint(): AgentModelEndpoint;
  /** Replaces `GET /v1/models` when present. */
  catalog?(): ModelCatalog;
  /** The saved model ID that new sessions start with. */
  model?(): string | undefined;
  saveModel?(id: string): void;
  /** What the ACP client or local host can do. `terminal` offers the bash tool. */
  capabilities: HostCapabilities;
  /** Listing and search for `root`. */
  filesystem: FileSystem;
  /** Listing and search for a session cwd other than `root`. */
  filesystemFor?(cwd: string): FileSystem;
  /** Absolute default cwd. */
  root: string;
  /** An ACP session/update notification. */
  update(sessionId: string, update: Params): void;
  /** An ACP client request: fs/*, terminal/*, session/request_permission, oxbit/diagnostics. */
  request(method: string, params: Params): Promise<any>;
  /** Ask the model for a title after a session's first turn. Defaults to true. */
  generateTitles?: boolean;
  /** Session config options listed after model, reasoning and mode. */
  configOptions?(session: SessionView): ACPConfigOption[];
  /** Applies a value to one of configOptions(); resolves false for an ID it does not own. */
  setConfigOption?(session: SessionView, configId: string, value: string): Promise<boolean>;
  extensions?: AgentExtensions;
}
