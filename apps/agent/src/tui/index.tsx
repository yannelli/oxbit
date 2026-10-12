/* @jsxRuntime automatic */
import { render, type RenderOptions } from "ink";
import { App } from "./app.js";
import { Controller, type HistoryStore } from "./controller.js";
import type { TuiConnection } from "./connection.js";
import { fileHistory, memoryTuiConnection } from "./memory.js";
import { draftOf } from "./editor.js";
import { resolveTheme } from "./theme.js";
import type { PermissionMode } from "@oxbit/agent-core";
import type { MemoryConnection } from "../connection.js";

export type * from "./connection.js";
export type { HistoryStore } from "./controller.js";
export { markdownToAnsi } from "./markdown.js";

export interface RunOptions {
  /** Absolute working directory for session/new. */
  cwd: string;
  /** Loads this session instead of starting a new one. */
  sessionId?: string;
  /** Sent as the first prompt once the session is open. */
  prompt?: string;
  theme?: "dark" | "light" | "auto";
  /** Shown in the banner. */
  version?: string;
  history?: HistoryStore;
  stdin?: NodeJS.ReadStream | NodeJS.ReadableStream;
  stdout?: NodeJS.WriteStream | NodeJS.WritableStream;
  stderr?: NodeJS.WriteStream | NodeJS.WritableStream;
  /** Writes each frame in full without erasing; tests read frames this way. */
  debug?: boolean;
}

/** Runs the TUI until the user exits. Resolves with the last session ID so the CLI can print a resume hint. */
export async function run(connection: TuiConnection, options: RunOptions): Promise<{ sessionId?: string }> {
  const controller = new Controller(connection, { cwd: options.cwd, history: options.history });
  const exited = new Promise<void>((resolve) => { controller.onExit = resolve; });
  const streams = Object.fromEntries(Object.entries({ stdin: options.stdin, stdout: options.stdout, stderr: options.stderr }).filter(([, value]) => value));
  const instance = render(<App controller={controller} theme={resolveTheme(options.theme)} version={options.version} />, {
    ...streams as Pick<RenderOptions, "stdin" | "stdout" | "stderr">,
    exitOnCtrlC: false,
    ...options.debug ? { debug: true } : { kittyKeyboard: { mode: "auto" } },
  });
  void controller.open(options.sessionId).then(() => {
    if (!options.prompt) return;
    controller.setDraft(draftOf(options.prompt));
    controller.submit();
  });
  try {
    await Promise.race([exited, instance.waitUntilExit()]);
  } finally {
    controller.dispose();
    instance.unmount();
  }
  return { sessionId: controller.getState().status.sessionId };
}

export interface RunTuiOptions {
  connection: MemoryConnection;
  cwd: string;
  sessionId?: string;
  prompt?: string;
  mode?: PermissionMode;
  /** Provider name for the status line. */
  providerLabel?: string;
  usingChatGPTPlan?: boolean;
  version: string;
  /** JSON lines file for prompt history. */
  historyPath?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

/** The CLI entry: runs the TUI over the in-memory ACP connection and prints how to resume the session. */
export async function runTui(options: RunTuiOptions): Promise<number> {
  const connection = memoryTuiConnection(options.connection,
    { provider: options.providerLabel, usingChatGPTPlan: options.usingChatGPTPlan, mode: options.mode });
  const { sessionId } = await run(connection, { cwd: options.cwd, sessionId: options.sessionId, prompt: options.prompt, version: options.version,
    history: options.historyPath ? fileHistory(options.historyPath) : undefined, stdin: options.stdin, stdout: options.stdout, stderr: options.stderr });
  if (sessionId) (options.stderr ?? process.stderr).write(`Resume this session with: oxbit-agent -r ${sessionId}\n`);
  return 0;
}
