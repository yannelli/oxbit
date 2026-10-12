import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PermissionMode } from "@oxbit/agent-core";
import type { AcpClient } from "../connection.js";
import { walkFiles } from "../fs.js";
import type {
  ConfigOption, ConnectionInfo, PermissionOutcome, PermissionRequest, SessionState, SessionUpdate, SettingsManager, TuiConnection,
} from "./connection.js";
import type { HistoryStore } from "./controller.js";

const FILE_LIST_TTL_MS = 10_000;
const FILE_MATCHES = 2000;
const HISTORY_LIMIT = 500;

export interface MemoryTuiOptions {
  /** Provider name for the status line. */
  provider?: string;
  usingChatGPTPlan?: boolean;
  /** Applied to each new session; a mode chosen in /config replaces it. */
  mode?: PermissionMode;
  /** The agent's mode ID for each Oxbit mode, when they differ. */
  modes?: Record<PermissionMode, string>;
  /** Applied to each new session through setModel. */
  model?: string;
  settings?: SettingsManager;
}
export interface MemoryTuiConnection extends TuiConnection {
  /** The connection in use. */
  readonly connection: AcpClient;
  /** Moves update listeners and the permission handler to `next`, then closes the previous connection. `options` replaces the mode map and model. */
  replace(next: AcpClient, info: ConnectionInfo, options?: Pick<MemoryTuiOptions, "modes" | "model">): Promise<void>;
}
type UpdateListener = (sessionId: string, update: SessionUpdate) => void;
type PermissionHandler = (request: PermissionRequest) => Promise<PermissionOutcome>;

const subsequence = (query: string, path: string) => {
  let at = 0;
  for (const char of query) {
    at = path.indexOf(char, at) + 1;
    if (!at) return false;
  }
  return true;
};

/** The TUI's connection over the in-memory ACP client, with @file listing from the working tree. replace() swaps the client after a rebuild. */
export function memoryTuiConnection(initial: AcpClient, options: MemoryTuiOptions = {}): MemoryTuiConnection {
  let connection = initial;
  let { modes, model } = options;
  let info: ConnectionInfo = { provider: options.provider, usingChatGPTPlan: options.usingChatGPTPlan };
  let mode = options.mode;
  const listeners = new Set<UpdateListener>();
  let permission: PermissionHandler | undefined;
  const attach = (target: AcpClient) => [
    target.onUpdate((sessionId, update) => {
      for (const listener of [...listeners]) {
        try {
          listener(sessionId, update as SessionUpdate);
        } catch {
          // One failing listener must not stop the others.
        }
      }
    }),
    target.onPermission(async (request) => permission ? (await permission(request as PermissionRequest)).outcome : { outcome: "cancelled" }),
  ];
  let detach = attach(connection);
  const listed = new Map<string, { at: number; files: Promise<string[]> }>();
  const files = (cwd: string) => {
    const cached = listed.get(cwd);
    if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.files;
    const entry = { at: Date.now(), files: walkFiles(cwd).catch(() => []) };
    listed.set(cwd, entry);
    return entry.files;
  };
  const settings = options.settings;
  return {
    get connection() {
      return connection;
    },
    async replace(next, nextInfo, nextOptions = {}) {
      ({ modes, model } = nextOptions);
      const previous = connection;
      for (const stop of detach) stop();
      connection = next;
      detach = attach(next);
      info = { ...nextInfo };
      await previous.close();
    },
    info: () => ({ ...info }),
    async newSession(cwd) {
      let state = await connection.newSession({ cwd }) as SessionState;
      if (model) state = { ...state, ...await connection.setModel(state.sessionId, model) as Pick<SessionState, "configOptions"> };
      const modeId = mode && (modes?.[mode] ?? mode);
      if (!modeId || !state.modes || state.modes.currentModeId === modeId) return state;
      await connection.setMode(state.sessionId, modeId);
      return { ...state, modes: { ...state.modes, currentModeId: modeId } };
    },
    loadSession: async (sessionId, cwd) => await connection.loadSession(sessionId, { cwd }) as SessionState,
    listSessions: async (cwd) => (await connection.listSessions(cwd)).sessions,
    prompt: (sessionId, prompt) => connection.prompt(sessionId, prompt),
    cancel: (sessionId) => connection.cancel(sessionId),
    setMode: (sessionId, modeId) => connection.setMode(sessionId, modeId),
    setModel: async (sessionId, modelId) => await connection.setModel(sessionId, modelId) as { configOptions?: ConfigOption[] },
    setConfigOption: async (sessionId, configId, value) =>
      await connection.setConfigOption(sessionId, configId, value) as { configOptions?: ConfigOption[] },
    onUpdate(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onPermission(handler) {
      permission = handler;
      return () => {
        if (permission === handler) permission = undefined;
      };
    },
    async listFiles(query, cwd) {
      const term = query.toLowerCase();
      return (await files(cwd)).filter((path) => subsequence(term, path.toLowerCase())).slice(0, FILE_MATCHES);
    },
    ...settings ? { settings: {
      panel: (id, context) => settings.panel(id, context),
      toggle: (id, rowId, enabled, context) => settings.toggle(id, rowId, enabled, context),
      async choose(id, rowId, value, context) {
        const change = await settings.choose(id, rowId, value, context);
        if (change.mode) mode = change.mode as PermissionMode;
        return change;
      },
      act: (id, rowId, actionId, inputs, context) => settings.act(id, rowId, actionId, inputs, context),
    } satisfies SettingsManager } : {},
  };
}

/** Prompt history as JSON lines, newest last, trimmed to HISTORY_LIMIT entries when it grows past twice that. */
export function fileHistory(path: string): HistoryStore {
  return {
    load() {
      try {
        return readFileSync(path, "utf8").split("\n").flatMap((line) => {
          try {
            const entry = JSON.parse(line);
            return typeof entry === "string" ? [entry] : [];
          } catch {
            return [];
          }
        }).slice(-HISTORY_LIMIT);
      } catch {
        return [];
      }
    },
    save(entry) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        if (lines.length > HISTORY_LIMIT * 2) writeFileSync(path, `${lines.slice(-HISTORY_LIMIT).join("\n")}\n`, { mode: 0o600 });
      } catch {
        // History is best effort; a read-only home keeps the TUI working.
      }
    },
  };
}
