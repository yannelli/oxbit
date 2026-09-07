import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import * as pty from "node-pty";
import { RpcError, MAX_BUFFER_BYTES } from "@oxbit/protocol";
import { resolveTerminalShell } from "./terminal-shell.js";

export interface Chunk {
  seq: number;
  data: string;
}
export interface ProcessEvent {
  event: string;
  params: Record<string, unknown>;
  stream?: string;
  seq?: number;
}
type Emit = (event: ProcessEvent, owner?: string) => void;
interface Terminal {
  id: string;
  owner: string;
  pty: pty.IPty;
  seq: number;
  chunks: Chunk[];
  bytes: number;
  exitCode?: number;
  subscribers: Map<string, { sent: number; acked: number }>;
  paused: boolean;
}
interface Task {
  id: string;
  owner: string;
  command: string;
  process: ChildProcess;
  exitCode?: number;
  chunks: Chunk[];
  bytes: number;
  seq: number;
}
export function killProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* Process has exited. */
    }
  }, 1500);
  timer.unref();
}
export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    onData?: (data: string) => void;
    env?: NodeJS.ProcessEnv;
    maxBytes?: number;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (options.signal?.aborted)
    throw new RpcError("CANCELLED", "Operation was cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      overflow = false;
    const cancel = () => killProcess(child);
    options.signal?.addEventListener("abort", cancel, { once: true });
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    const data = (value: Buffer, out: boolean) => {
      const chunk = (out ? stdoutDecoder : stderrDecoder).write(value);
      bytes += value.length;
      if (bytes > (options.maxBytes ?? 16 * MAX_BUFFER_BYTES)) {
        overflow = true;
        killProcess(child);
        return;
      }
      if (out) stdout += chunk;
      else stderr += chunk;
      options.onData?.(chunk);
    };
    child.stdout.on("data", (value) => data(value, true));
    child.stderr.on("data", (value) => data(value, false));
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", cancel);
      reject(error);
    });
    child.on("close", (code) => {
      const tailOut = stdoutDecoder.end(), tailError = stderrDecoder.end(); stdout += tailOut; stderr += tailError; if (tailOut) options.onData?.(tailOut); if (tailError) options.onData?.(tailError);
      options.signal?.removeEventListener("abort", cancel);
      if (options.signal?.aborted)
        reject(new RpcError("CANCELLED", "Operation was cancelled"));
      else if (overflow)
        reject(
          new RpcError("OUTPUT_LIMIT", "Command output exceeded its limit"),
        );
      else resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
export class Processes {
  private terminals = new Map<string, Terminal>();
  private tasks = new Map<string, Task>();
  constructor(
    private root: string,
    private emit: Emit,
  ) {}
  private terminal(id: string, owner: string) {
    const value = this.terminals.get(id);
    if (!value || value.owner !== owner)
      throw new RpcError("NOT_FOUND", "Terminal session was not found");
    return value;
  }
  create(owner: string, connection: string, cols = 100, rows = 30) {
    for (const [id, terminal] of this.terminals) if (this.terminals.size >= 64 && terminal.exitCode !== undefined) this.terminals.delete(id);
    if (
      [...this.terminals.values()].filter((t) => t.exitCode === undefined)
        .length >= 16
    )
      throw new RpcError("LIMIT", "Maximum 16 terminal sessions");
    const id = randomUUID(),
      { shell, args } = resolveTerminalShell();
    const terminal = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: this.dimension(cols, 1000),
      rows: this.dimension(rows, 500),
      cwd: this.root,
      env: { ...process.env, SHELL: shell, TERM: "xterm-256color" },
    });
    const session: Terminal = {
      id,
      owner,
      pty: terminal,
      seq: 0,
      chunks: [],
      bytes: 0,
      subscribers: new Map([[connection, { sent: 0, acked: 0 }]]),
      paused: false,
    };
    this.terminals.set(id, session);
    terminal.onData((data) => {
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 16384, data.length);
        if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end--;
        const chunk = { seq: ++session.seq, data: data.slice(offset, end) }; offset = end;
        session.chunks.push(chunk);
        session.bytes += Buffer.byteLength(chunk.data);
        while (session.bytes > MAX_BUFFER_BYTES && session.chunks.length > 1)
          session.bytes -= Buffer.byteLength(session.chunks.shift()!.data);
        for (const subscriber of session.subscribers.values())
          subscriber.sent = chunk.seq;
        this.emit(
          {
            event: "terminal.data",
            params: { id, ...chunk },
            stream: `terminal:${id}`,
            seq: chunk.seq,
          },
          owner,
        );
      }
      this.flow(session);
    });
    terminal.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      this.emit({ event: "terminal.exit", params: { id, exitCode } }, owner);
    });
    return { id };
  }
  private dimension(value: number, max: number) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RpcError("INVALID_PARAMS", "Invalid terminal dimensions");
    return value;
  }
  private flow(session: Terminal) {
    const slow =
      session.subscribers.size === 0 ||
      [...session.subscribers.values()].some(
        (sub) =>
          session.chunks
            .filter((c) => c.seq > sub.acked)
            .reduce((n, c) => n + Buffer.byteLength(c.data), 0) >
          128 * 1024,
      );
    if (slow && !session.paused) {
      session.pty.pause();
      session.paused = true;
    } else if (!slow && session.paused) {
      session.pty.resume();
      session.paused = false;
    }
  }
  input(id: string, owner: string, data: string) {
    const t = this.terminal(id, owner);
    if (t.exitCode !== undefined)
      throw new RpcError("TERMINATED", "Terminal has exited");
    t.pty.write(data);
  }
  resize(id: string, owner: string, cols: number, rows: number) {
    this.terminal(id, owner).pty.resize(
      this.dimension(cols, 1000),
      this.dimension(rows, 500),
    );
  }
  kill(id: string, owner: string) {
    this.terminal(id, owner).pty.kill();
  }
  list(owner: string) {
    return [...this.terminals.values()]
      .filter((t) => t.owner === owner)
      .map((t) => ({ id: t.id, exitCode: t.exitCode, seq: t.seq }));
  }
  attach(id: string, owner: string, connection: string, afterSeq = 0) {
    const t = this.terminal(id, owner);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > t.seq)
      throw new RpcError("INVALID_PARAMS", "Invalid terminal sequence");
    t.subscribers.set(connection, { sent: t.seq, acked: afterSeq });
    this.flow(t);
    return {
      id,
      chunks: t.chunks.filter((c) => c.seq > afterSeq),
      seq: t.seq,
      exitCode: t.exitCode,
      truncated: afterSeq < (t.chunks[0]?.seq ?? 1) - 1,
    };
  }
  ack(id: string, owner: string, connection: string, seq: number) {
    const t = this.terminal(id, owner),
      sub = t.subscribers.get(connection);
    if (!sub || !Number.isSafeInteger(seq) || seq < sub.acked || seq > sub.sent)
      throw new RpcError("INVALID_PARAMS", "Invalid terminal acknowledgement");
    sub.acked = seq;
    this.flow(t);
  }
  disconnect(connection: string) {
    for (const t of this.terminals.values()) {
      t.subscribers.delete(connection);
      this.flow(t);
    }
  }
  runTask(owner: string, command: string) {
    for (const [id, task] of this.tasks) if (this.tasks.size >= 128 && task.exitCode !== undefined) this.tasks.delete(id);
    if (
      [...this.tasks.values()].filter((t) => t.exitCode === undefined).length >=
      16
    )
      throw new RpcError("LIMIT", "Maximum 16 running tasks");
    const id = randomUUID(),
      child = spawn(command, {
        cwd: this.root,
        env: process.env,
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    const task: Task = {
      id,
      owner,
      command,
      process: child,
      chunks: [],
      bytes: 0,
      seq: 0,
    };
    this.tasks.set(id, task);
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    const onData = (data: string) => {
      if (!data) return;
      const chunk = { seq: ++task.seq, data };
      task.chunks.push(chunk);
      task.bytes += Buffer.byteLength(data);
      while (task.bytes > MAX_BUFFER_BYTES && task.chunks.length > 1)
        task.bytes -= Buffer.byteLength(task.chunks.shift()!.data);
      this.emit(
        {
          event: "tasks.data",
          params: { id, ...chunk },
          stream: `task:${id}`,
          seq: chunk.seq,
        },
        owner,
      );
    };
    child.stdout!.on("data", (data:Buffer) => onData(stdoutDecoder.write(data)));
    child.stderr!.on("data", (data:Buffer) => onData(stderrDecoder.write(data)));
    child.on("error", (error) => onData(error.message));
    child.on("close", (code) => {
      onData(stdoutDecoder.end()); onData(stderrDecoder.end());
      task.exitCode = code ?? -1;
      this.emit(
        { event: "tasks.exit", params: { id, exitCode: task.exitCode } },
        owner,
      );
    });
    return { id };
  }
  cancelTask(id: string, owner: string) {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner)
      throw new RpcError("NOT_FOUND", "Task was not found");
    killProcess(task.process);
  }
  listTasks(owner: string) {
    return [...this.tasks.values()]
      .filter((t) => t.owner === owner)
      .map((t) => ({
        id: t.id,
        command: t.command,
        exitCode: t.exitCode,
        seq: t.seq,
      }));
  }
  attachTask(id: string, owner: string, afterSeq = 0) {
    const t = this.tasks.get(id);
    if (!t || t.owner !== owner)
      throw new RpcError("NOT_FOUND", "Task was not found");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > t.seq) throw new RpcError("INVALID_PARAMS", "Invalid task sequence");
    return {
      id,
      chunks: t.chunks.filter((c) => c.seq > afterSeq),
      seq: t.seq,
      exitCode: t.exitCode,
      truncated: afterSeq < (t.chunks[0]?.seq ?? 1) - 1,
    };
  }
  revoke(owner: string) {
    for (const t of this.terminals.values())
      if (t.owner === owner && t.exitCode === undefined) t.pty.kill();
    for (const t of this.tasks.values())
      if (t.owner === owner) killProcess(t.process);
  }
  close() {
    for (const t of this.terminals.values())
      if (t.exitCode === undefined) t.pty.kill();
    for (const t of this.tasks.values()) killProcess(t.process);
  }
}
