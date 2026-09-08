/** Portable task definitions. Commands run only after workspace trust is granted. */
export type TaskPort = number | "auto" | { min: number; max: number };
export interface TaskDefinition {
  command: string;
  type?: "command" | "service";
  execution?: "shell" | "process";
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  dependsOn?: string[];
  dependencyOrder?: "sequence" | "parallel";
  group?: "build" | "test";
  host?: string;
  hostname?: string;
  port?: TaskPort;
  ports?: Record<string, TaskPort>;
  ready?: {
    pattern?: string;
    url?: string;
    timeoutMs?: number;
    intervalMs?: number;
  };
  restart?: {
    policy: "never" | "on-failure";
    maxAttempts?: number;
    delayMs?: number;
  };
  stop?: { signal?: "SIGTERM" | "SIGINT"; timeoutMs?: number };
}
export const taskPhases = [
  "preinit",
  "init",
  "preteardown",
  "teardown",
] as const;
export type TaskPhase = (typeof taskPhases)[number];
export type TaskHooks = Partial<Record<TaskPhase, string | string[]>>;
export interface TaskConfig {
  version: 1;
  /** Set false after exporting imports into this file. */
  autoDetect?: boolean;
  tasks: Record<string, TaskDefinition>;
  env?: Record<string, string>;
  worktree?: TaskHooks;
}
export type TaskSourceKind =
  | "oxbit"
  | "paseo"
  | "vscode"
  | "vscode-launch"
  | "jetbrains"
  | "npm"
  | "composer"
  | "procfile"
  | "make"
  | "just";
export interface TaskSource {
  id: string;
  kind: TaskSourceKind;
  path: string;
  revision: string | null;
  writable: boolean;
  private: boolean;
  diagnostics: string[];
}
export interface ConfiguredTask extends TaskDefinition {
  id: string;
  name: string;
  sourceId: string;
  /** Exact command in the source format (e.g. an npm script body). */
  sourceCommand?: string;
  disabledReason?: string;
}
export interface TaskCatalog {
  projectId: string;
  projectDir: string;
  privatePath: string;
  defaultSourceId: string;
  sources: TaskSource[];
  tasks: ConfiguredTask[];
  worktree: TaskHooks;
  env: Record<string, string>;
}
export type TaskState =
  | "starting"
  | "running"
  | "ready"
  | "unhealthy"
  | "restarting"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";
export interface TaskRun {
  /** Monotonic status revision, independent of output chunk sequence. */
  statusVersion: number;
  id: string;
  taskId?: string;
  name: string;
  command: string;
  type: "command" | "service";
  state: TaskState;
  pid?: number;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: string;
  restarts: number;
  seq: number;
  links: string[];
  variables: Record<string, string>;
  message?: string;
}
export interface TaskWorktree {
  id: string;
  path: string;
  branch: string;
  preinitDir: string;
  state:
    | "creating"
    | "ready"
    | "init-failed"
    | "removing"
    | "teardown-failed"
    | "removed";
  message?: string;
}
