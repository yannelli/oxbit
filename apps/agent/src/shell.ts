import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Params } from "@oxbit/agent-core";

const MAX_BYTES = 1024 * 1024;
const MAX_TERMINALS = 16;
interface ExitStatus { exitCode: number | null; signal: string | null }
interface Terminal {
  sessionId: string;
  child: ChildProcess;
  limit: number;
  output: string;
  truncated: boolean;
  exitStatus?: ExitStatus;
  exited: Promise<ExitStatus>;
}

/** Sends SIGTERM to the process group, then SIGKILL after 1.5 s. */
export function killProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name);
    } catch {
      child.kill(name);
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 1500).unref();
}

const string = (params: Params, key: string, limit = 16384) => {
  const value = params[key];
  if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new Error(`Invalid ${key}`);
  return value;
};

/** ACP terminal/* served with child_process: the command runs directly with its args in its own process group. */
export class Terminals {
  private terminals = new Map<string, Terminal>();
  async handle(method: string, params: Params): Promise<unknown> {
    if (method === "terminal/create") return this.create(params);
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal || terminal.sessionId !== params.sessionId) throw new Error("Unknown terminal");
    switch (method) {
      case "terminal/output":
        return { output: terminal.output, truncated: terminal.truncated, ...terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {} };
      case "terminal/wait_for_exit": return terminal.exited;
      case "terminal/kill":
        killProcess(terminal.child);
        return {};
      case "terminal/release":
        killProcess(terminal.child);
        this.terminals.delete(params.terminalId);
        return {};
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
  private create(params: Params) {
    if (this.terminals.size >= MAX_TERMINALS) throw new Error("Terminal limit reached");
    const sessionId = string(params, "sessionId", 256);
    const command = string(params, "command");
    if (!command) throw new Error("Invalid command");
    const args = params.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid args");
    const cwd = params.cwd === undefined || params.cwd === null ? process.cwd() : string(params, "cwd", 4096);
    if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
    const env = { ...process.env };
    for (const entry of Array.isArray(params.env) ? params.env : []) {
      const name = string(entry, "name", 256);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable ${name}`);
      env[name] = string(entry, "value");
    }
    const limit = params.outputByteLimit ?? MAX_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BYTES) throw new Error(`outputByteLimit must be between 1 and ${MAX_BYTES}`);
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const terminal: Terminal = { sessionId, child, limit, output: "", truncated: false, exited: Promise.resolve({ exitCode: null, signal: null }) };
    const append = (data: string) => {
      terminal.output += data;
      const bytes = Buffer.from(terminal.output);
      if (bytes.length <= limit) return;
      let start = bytes.length - limit;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      terminal.output = bytes.subarray(start).toString("utf8");
      terminal.truncated = true;
    };
    child.stdout!.setEncoding("utf8").on("data", append);
    child.stderr!.setEncoding("utf8").on("data", append);
    terminal.exited = new Promise((resolve) => {
      const finish = (exitCode: number | null, signal: string | null) => {
        terminal.exitStatus ??= { exitCode, signal };
        resolve(terminal.exitStatus);
      };
      child.on("error", (error) => {
        append(`${error.message}\n`);
        finish(127, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });
    const terminalId = randomUUID();
    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }
  /** Kills every running command. */
  dispose() {
    for (const terminal of this.terminals.values()) killProcess(terminal.child);
    this.terminals.clear();
  }
}
