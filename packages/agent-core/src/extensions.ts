import type { FileSystem } from "@oxbit/sdk";
import type { ToolSpec, Turn } from "./model.js";

export type Params = Record<string, any>;

export interface SessionView {
  id: string;
  /** Absolute working directory from session/new, or the host root. */
  cwd: string;
  model: string;
  turns: readonly Turn[];
  /** Extension state that SessionStore persists. The agent keeps `mode`, `title`, `mcpServers` and `snapshots` here. */
  meta: Record<string, unknown>;
}

/** ACP session mode. `ask` reviews writes and asks before shell commands; `accept-edits` applies writes; `full-auto` asks only for hooks. */
export type PermissionMode = "ask" | "accept-edits" | "full-auto";

export interface ToolContext {
  /** The session cwd. Tool paths resolve against it. */
  root: string;
  sessionId: string;
  toolCallId: string;
  mode: PermissionMode;
  filesystem: FileSystem;
  signal: AbortSignal;
  /** An ACP client request: fs/*, terminal/*, session/request_permission or oxbit/diagnostics. */
  request(method: string, params: Params): Promise<any>;
  update(update: Params): void;
}

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export interface AgentTool {
  spec: ToolSpec;
  kind: ToolKind;
  title(args: Params): string;
  /** Mutating tools trigger a snapshot before they run. */
  mutates?: boolean;
  run(args: Params, context: ToolContext): Promise<string>;
}
export interface ToolProvider { tools(session: SessionView): AgentTool[] | Promise<AgentTool[]> }
/** Returns a system prompt section, or undefined to add nothing. */
export interface ContextProvider { system(session: SessionView): Promise<string | undefined> }

export interface CommandContext {
  session: SessionView;
  signal: AbortSignal;
  update(update: Params): void;
  request(method: string, params: Params): Promise<any>;
  /** Replaces the conversation, for example for /clear. */
  replaceTurns(turns: Turn[]): void;
  /** Runs the compactor now with trigger "manual". Resolves false when there is no compactor or a hook blocks it. */
  compact(): Promise<boolean>;
}
export interface AgentCommand {
  name: string;
  description: string;
  hint?: string;
  /** `prompt` turns the command into a model turn; `done` ends it with that ACP stop reason. */
  run(args: string, context: CommandContext): Promise<{ prompt: string } | { done: string }>;
}
export interface CommandProvider { commands(session: SessionView): AgentCommand[] | Promise<AgentCommand[]> }

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "Stop"
  | "PreCompact" | "PostCompact" | "SessionEnd";
export interface HookOutcome {
  /** false stops the agent. */
  continue?: boolean;
  stopReason?: string;
  /** decision "block" or exit code 2. */
  block?: boolean;
  reason?: string;
  permission?: "allow" | "deny" | "ask";
  permissionReason?: string;
  updatedInput?: Params;
  /** Capped at 10,000 characters. */
  additionalContext?: string;
  systemMessage?: string;
}
/** `input` carries Claude Code hook fields: session_id, cwd, hook_event_name, and the event's own fields. */
export interface HookRunner { run(event: HookEvent, input: Params, signal: AbortSignal): Promise<HookOutcome> }

/** Called when the model ends a turn without tool calls; text continues the turn as a user message. */
export interface ContinuationProvider { next(session: SessionView, signal: AbortSignal): Promise<string | undefined> }
export interface Compactor {
  shouldCompact(session: SessionView, usage: { input: number; output: number }, contextWindow?: number, maxOutput?: number): boolean;
  compact(session: SessionView, summarize: (system: string, turns: Turn[]) => Promise<string>, signal: AbortSignal): Promise<Turn[]>;
}
export interface SnapshotStore {
  capture(label: string): Promise<string | undefined>;
  restore(id: string): Promise<void>;
}
export interface SessionRecord {
  id: string;
  cwd: string;
  title: string;
  model: string;
  turns: Turn[];
  meta: Record<string, unknown>;
  updatedAt: string;
}
export interface SessionStore {
  save(record: SessionRecord): Promise<void>;
  load(id: string): Promise<SessionRecord | undefined>;
  list(cwd: string): Promise<Omit<SessionRecord, "turns">[]>;
}

export interface AgentExtensions {
  tools?: ToolProvider[];
  context?: ContextProvider[];
  commands?: CommandProvider[];
  hooks?: HookRunner;
  continuations?: ContinuationProvider[];
  compactor?: Compactor;
  snapshots?: SnapshotStore;
  sessions?: SessionStore;
}
