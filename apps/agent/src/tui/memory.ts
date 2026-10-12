import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PermissionMode } from "@oxbit/agent-core";
import type { MemoryConnection } from "../connection.js";
import { walkFiles } from "../fs.js";
import type { ConfigOption, PermissionRequest, SessionState, SessionUpdate, TuiConnection } from "./connection.js";
import type { HistoryStore } from "./controller.js";

const FILE_LIST_TTL_MS = 10_000;
const FILE_MATCHES = 2000;
const HISTORY_LIMIT = 500;

export interface MemoryTuiOptions {
  /** Provider name for the status line. */
  provider?: string;
  usingChatGPTPlan?: boolean;
  /** Applied to each new session. */
  mode?: PermissionMode;
}

const subsequence = (query: string, path: string) => {
  let at = 0;
  for (const char of query) {
    at = path.indexOf(char, at) + 1;
    if (!at) return false;
  }
  return true;
};

/** The TUI's connection over the in-memory ACP client, with @file listing from the working tree. */
export function memoryTuiConnection(connection: MemoryConnection, options: MemoryTuiOptions = {}): TuiConnection {
  const listed = new Map<string, { at: number; files: Promise<string[]> }>();
  const files = (cwd: string) => {
    const cached = listed.get(cwd);
    if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.files;
    const entry = { at: Date.now(), files: walkFiles(cwd).catch(() => []) };
    listed.set(cwd, entry);
    return entry.files;
  };
  return {
    info: () => ({ provider: options.provider, usingChatGPTPlan: options.usingChatGPTPlan }),
    async newSession(cwd) {
      const state = await connection.newSession({ cwd }) as SessionState;
      if (!options.mode || !state.modes || state.modes.currentModeId === options.mode) return state;
      await connection.setMode(state.sessionId, options.mode);
      return { ...state, modes: { ...state.modes, currentModeId: options.mode } };
    },
    loadSession: async (sessionId, cwd) => await connection.loadSession(sessionId, { cwd }) as SessionState,
    listSessions: async (cwd) => (await connection.listSessions(cwd)).sessions,
    prompt: (sessionId, prompt) => connection.prompt(sessionId, prompt),
    cancel: (sessionId) => connection.cancel(sessionId),
    setMode: (sessionId, modeId) => connection.setMode(sessionId, modeId as PermissionMode),
    setModel: async (sessionId, modelId) => await connection.setModel(sessionId, modelId) as { configOptions?: ConfigOption[] },
    setConfigOption: async (sessionId, configId, value) =>
      await connection.setConfigOption(sessionId, configId, value) as { configOptions?: ConfigOption[] },
    onUpdate: (listener) => connection.onUpdate((sessionId, update) => listener(sessionId, update as SessionUpdate)),
    onPermission: (handler) => connection.onPermission(async (request) => (await handler(request as PermissionRequest)).outcome),
    async listFiles(query, cwd) {
      const term = query.toLowerCase();
      return (await files(cwd)).filter((path) => subsequence(term, path.toLowerCase())).slice(0, FILE_MATCHES);
    },
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
