/* @jsxRuntime automatic */
import { render, type RenderOptions } from "ink";
import { App } from "./app.js";
import { Controller, type HistoryStore } from "./controller.js";
import type { TuiConnection } from "./connection.js";
import { fileHistory, memoryTuiConnection } from "./memory.js";
import { draftOf } from "./editor.js";
import { resolveTheme } from "./theme.js";
import { oscTitle, windowTitle } from "./transcript-export.js";
import type { PermissionMode } from "@oxbit/agent-core";
import type { AcpClient } from "../connection.js";

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
  /** Alternate screen with the prompt pinned to the bottom; defaults to on for a TTY outside debug mode. */
  fullscreen?: boolean;
}

const CLEAR = "\x1b[2J\x1b[H";
const CLEAR_SCROLLBACK = "\x1b[2J\x1b[3J\x1b[H";

/** Runs the TUI until the user exits. Resolves with the last session ID so the CLI can print a resume hint. */
export async function run(connection: TuiConnection, options: RunOptions): Promise<{ sessionId?: string }> {
  const stdout = options.stdout ?? process.stdout;
  const tty = !!(stdout as { isTTY?: boolean }).isTTY;
  const fullscreen = options.fullscreen ?? (tty && !options.debug);
  const screen = {
    write: (sequence: string) => void stdout.write(sequence),
    clear: () => {
      instance.clear();
      stdout.write(fullscreen ? CLEAR : CLEAR_SCROLLBACK);
    },
  };
  const controller = new Controller(connection, { cwd: options.cwd, history: options.history, screen });
  const exited = new Promise<void>((resolve) => { controller.onExit = resolve; });
  let title: string | undefined;
  const showTitle = () => {
    const { status, running } = controller.getState();
    const next = windowTitle(status.title, running);
    if (tty && next !== title) stdout.write(oscTitle(title = next));
  };
  const unsubscribe = controller.subscribe(showTitle);
  showTitle();
  const streams = Object.fromEntries(Object.entries({ stdin: options.stdin, stdout: options.stdout, stderr: options.stderr }).filter(([, value]) => value));
  const instance = render(<App controller={controller} theme={resolveTheme(options.theme)} version={options.version} fullscreen={fullscreen} />, {
    ...streams as Pick<RenderOptions, "stdin" | "stdout" | "stderr">,
    exitOnCtrlC: false,
    alternateScreen: fullscreen,
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
    unsubscribe();
    controller.dispose();
    instance.unmount();
    await instance.waitUntilExit().catch(() => {});
    if (title !== undefined) stdout.write(oscTitle(""));
  }
  return { sessionId: controller.getState().status.sessionId };
}

export interface RunTuiOptions {
  connection: AcpClient;
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
  fullscreen?: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

/** The CLI entry: runs the TUI over the in-memory ACP connection and prints how to resume the session. */
export async function runTui(options: RunTuiOptions): Promise<number> {
  const connection = memoryTuiConnection(options.connection,
    { provider: options.providerLabel, usingChatGPTPlan: options.usingChatGPTPlan, mode: options.mode });
  const { sessionId } = await run(connection, { cwd: options.cwd, sessionId: options.sessionId, prompt: options.prompt, version: options.version,
    history: options.historyPath ? fileHistory(options.historyPath) : undefined, stdin: options.stdin, stdout: options.stdout, stderr: options.stderr, fullscreen: options.fullscreen });
  if (sessionId) (options.stderr ?? process.stderr).write(`Resume this session with: oxbit-agent -r ${sessionId}\n`);
  return 0;
}
