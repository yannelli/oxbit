import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Agent, Params } from "@oxbit/agent-core";
import type { AgentFactory, ClientCapabilities, ClientLink } from "./host.js";

type Id = string | number;
export interface Message {
  jsonrpc?: "2.0";
  id?: Id | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}
interface Handlers {
  request(method: string, params: Params): Promise<unknown>;
  notification?(method: string, params: Params): void;
}

const errorOf = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return { code: typeof code === "number" ? code : -32603, message: error instanceof Error ? error.message : String(error) };
};

/** JSON-RPC 2.0 over any message channel: answers incoming requests and tracks outgoing ones. */
export class JsonRpcPeer {
  private pending = new Map<Id, { resolve(result: any): void; reject(error: Error): void }>();
  private next = 0;
  private closed?: string;
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private send: (message: Message) => void, private handlers: Handlers) {}
  receive(message: Message) {
    if (!message || typeof message !== "object") return this.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    const { id, method } = message;
    if (typeof method === "string") {
      const params = message.params ?? {};
      if (id === undefined || id === null) {
        try {
          this.handlers.notification?.(method, params);
        } catch {
          // Notifications have no reply channel.
        }
        return;
      }
      this.active++;
      void Promise.resolve().then(() => this.handlers.request(method, params)).then(
        (result) => this.send({ jsonrpc: "2.0", id, result: result ?? null }),
        (error) => this.send({ jsonrpc: "2.0", id, error: errorOf(error) })).finally(() => {
        if (--this.active) return;
        for (const resolve of this.waiters.splice(0)) resolve();
      });
      return;
    }
    const pending = id === undefined || id === null ? undefined : this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id!);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
    else pending.resolve(message.result);
  }
  request(method: string, params: Params): Promise<any> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params: Params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  /** Resolves when no incoming request is being handled. */
  idle() {
    return this.active ? new Promise<void>((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }
  parseError() {
    this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  /** Rejects pending and later outgoing requests. Notifications still go out. */
  close(reason: string) {
    this.closed = reason;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }
}

/** The agent side of an ACP connection: Agent methods in, session/update and client requests out. */
export class AcpServer {
  readonly peer: JsonRpcPeer;
  readonly agent: Agent;
  private capabilities: ClientCapabilities = {};
  private disposeHost: () => void;
  private closing?: Promise<void>;
  constructor(send: (message: Message) => void, factory: AgentFactory) {
    this.peer = new JsonRpcPeer(send, {
      request: (method, params) => this.handle(method, params),
      notification: (method, params) => {
        if (method === "session/cancel" && typeof params.sessionId === "string") this.agent.cancel(params.sessionId);
      },
    });
    const link: ClientLink = {
      capabilities: () => this.capabilities,
      update: (sessionId, update) => this.peer.notify("session/update", { sessionId, update }),
      request: (method, params) => this.peer.request(method, params),
    };
    const built = factory(link);
    this.agent = built.agent;
    this.disposeHost = built.dispose;
  }
  private async handle(method: string, params: Params) {
    if (method === "initialize") this.capabilities = params.clientCapabilities && typeof params.clientCapabilities === "object" ? params.clientCapabilities : {};
    return this.agent.handle(method, params);
  }
  receive(message: Message) {
    this.peer.receive(message);
  }
  /** Cancels running prompts, runs SessionEnd hooks and kills local terminals. */
  close(reason = "The ACP client disconnected") {
    return this.closing ??= (async () => {
      this.peer.close(reason);
      await this.agent.dispose("other").catch(() => {});
      this.disposeHost();
    })();
  }
}

export interface StdioOptions {
  input: Readable;
  output: Writable;
  factory: AgentFactory;
  log?(text: string): void;
}

/** ACP over newline-delimited JSON on `output`. After `input` ends, running requests finish without client requests; a broken `output` cancels them. */
export function serveStdio({ input, output, factory, log }: StdioOptions): Promise<void> {
  let broken = false;
  const server = new AcpServer((message) => {
    if (!broken) output.write(`${JSON.stringify(message)}\n`);
  }, factory);
  const lines = createInterface({ input, crlfDelay: Infinity });
  output.on("error", (error) => {
    broken = true;
    log?.(`ACP output closed: ${error.message}`);
    server.agent.cancel();
    lines.close();
  });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      server.peer.parseError();
      return;
    }
    server.receive(message);
  });
  return new Promise((resolve) => lines.once("close", () => {
    server.peer.close("The ACP client closed its input");
    void server.peer.idle().then(() => server.close()).then(resolve);
  }));
}
