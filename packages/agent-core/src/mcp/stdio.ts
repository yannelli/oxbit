import { McpError, isResponse, parseMessage, type JsonRpcMessage, type JsonRpcRequest, type Transport } from "./jsonrpc.js";

/** A child process the host started for a stdio MCP server. */
export interface StdioProcess {
  /** Writes text to stdin. The client sends one JSON-RPC message plus "\n" per call. */
  write(text: string): void;
  /** stdout split into lines; ends when stdout closes. */
  stdout: AsyncIterable<string>;
  /** Closes stdin, the graceful shutdown signal. */
  end(): void;
  /** Terminates the process: SIGTERM, then SIGKILL on POSIX. */
  kill(): void;
  /** Settles when the process has exited. */
  exited: Promise<unknown>;
}
export interface SpawnOptions {
  command: string;
  args: string[];
  /** Variables to add to the host's own environment. */
  env: Record<string, string>;
  cwd: string;
  /** Receives stderr text as it arrives. */
  stderr(text: string): void;
}
/** Host process spawning; Node uses child_process.spawn with PATH lookup. Absent on hosts that cannot run processes. */
export type Spawn = (options: SpawnOptions) => StdioProcess;

const STDERR_TAIL = 4000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Newline-delimited JSON-RPC over a child's stdin and stdout. */
export class StdioTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;
  stderr = "";
  private pending = new Map<string, { resolve(message: JsonRpcMessage): void; reject(error: Error): void }>();
  private process: StdioProcess;
  private closing = false;
  private ended = false;
  constructor(spawn: Spawn, options: Omit<SpawnOptions, "stderr">) {
    this.process = spawn({ ...options, stderr: (text) => void (this.stderr = (this.stderr + text).slice(-STDERR_TAIL)) });
    void this.read();
  }
  private async read() {
    let failure: Error | undefined;
    try {
      for await (const line of this.process.stdout) {
        const message = line.trim() ? parseMessage(line) : undefined;
        if (!message) continue;
        const waiter = isResponse(message) ? this.pending.get(String(message.id)) : undefined;
        if (waiter) {
          this.pending.delete(String(message.id));
          waiter.resolve(message);
        } else this.onmessage?.(message);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    this.ended = true;
    const tail = this.stderr.trim().split("\n").slice(-5).join("\n");
    const error = new McpError(`The MCP server exited${failure ? `: ${failure.message}` : ""}${tail ? `\n${tail}` : ""}`);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    if (!this.closing) this.onclose?.(error);
  }
  private write(message: JsonRpcMessage) {
    if (this.ended) throw new McpError("The MCP server is not running");
    this.process.write(`${JSON.stringify(message)}\n`);
  }
  request(message: JsonRpcRequest, signal?: AbortSignal) {
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const key = String(message.id);
      const abort = () => {
        if (!this.pending.delete(key)) return;
        reject(new McpError("The MCP request was cancelled"));
        if (!this.ended) this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: message.id, reason: "Cancelled by the user" } });
      };
      this.pending.set(key, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject,
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(key);
        reject(error);
      }
    });
  }
  async send(message: JsonRpcMessage) {
    this.write(message);
  }
  /** Closes stdin, waits up to 2 s for the exit, then kills the process. */
  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      this.process.end();
    } catch {
      // stdin is already closed.
    }
    const exited = await Promise.race([this.process.exited.then(() => true, () => true), wait(2000).then(() => false)]);
    if (!exited) {
      this.process.kill();
      await Promise.race([this.process.exited.catch(() => {}), wait(2000)]);
    }
  }
}
