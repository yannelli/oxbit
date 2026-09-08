import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ACP_PROVIDERS, type ACPConnection, type ACPLaunch } from "@oxbit/sdk";
import { RpcError, requireString } from "@oxbit/protocol";
import { WorkspaceFiles } from "./filesystem.js";
import { killProcess } from "./process-lifecycle.js";
import { trackChild } from "./owned-processes.js";

type Params = Record<string, any>;
type Pending = {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Approval = { rpcId: string | number; method: string; params: Params };
type Terminal = {
  child: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  limit: number;
  exitStatus?: { exitCode: number | null; signal: string | null };
  exited: Promise<unknown>;
};
type Agent = {
  connection: ACPConnection;
  owner: string;
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, Pending>;
  approvals: Map<string, Approval>;
  terminals: Map<string, Terminal>;
  buffer: string;
  busy: boolean;
  stopped: boolean;
  sequence: number;
  turn: number;
  newSessionUpdates?: Params[];
};
const MAX_BYTES = 1024 * 1024;
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some(
      (v) => typeof v !== "string" || v.length > 16384 || v.includes("\0"),
    )
  )
    throw new RpcError(
      "INVALID_PARAMS",
      "Arguments must be a JSON array of strings",
    );
  return value;
}
export class AgentACP {
  private agents = new Map<string, Agent>();
  constructor(
    private files: WorkspaceFiles,
    private emit: (owner: string, event: string, params: Params) => void,
  ) {}
  private get(owner: string, id: string) {
    const agent = this.agents.get(id);
    if (!agent || agent.owner !== owner || agent.stopped)
      throw new RpcError("NOT_FOUND", "Agent connection has ended");
    return agent;
  }
  private send(agent: Agent, message: Params) {
    const data = JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";
    if (agent.stopped || !agent.child.stdin.writable)
      throw new Error("Agent process has ended");
    if (
      Buffer.byteLength(data) > 2 * MAX_BYTES ||
      agent.child.stdin.writableLength > MAX_BYTES
    )
      throw new Error("Agent message queue is full");
    agent.child.stdin.write(data);
  }
  private request(
    agent: Agent,
    method: string,
    params: Params,
    timeout = 120000,
  ): Promise<any> {
    if (agent.pending.size >= 32)
      return Promise.reject(new Error("Too many pending ACP requests"));
    return new Promise((resolve, reject) => {
      const id = ++agent.sequence;
      const timer = setTimeout(() => {
        this.stopAgent(agent, `${method} timed out. Reconnect to continue.`);
      }, timeout);
      timer.unref();
      agent.pending.set(id, { resolve, reject, timer });
      try {
        this.send(agent, { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        agent.pending.delete(id);
        reject(error);
      }
    });
  }
  private publish(agent: Agent, event: string, params: Params) {
    this.emit(agent.owner, event, { id: agent.connection.id, ...params });
  }
  async start(
    owner: string,
    launch: ACPLaunch,
    signal?: AbortSignal,
  ): Promise<ACPConnection> {
    const preset = ACP_PROVIDERS.find((p) => p.id === launch.provider);
    if (!preset)
      throw new RpcError("INVALID_PARAMS", "Choose Codex, Cursor, or Amp");
    if (signal?.aborted) throw new Error("Agent connection cancelled");
    if ([...this.agents.values()].filter((a) => a.owner === owner).length >= 3)
      throw new RpcError("BUSY", "Disconnect an agent before starting another");
    const command = requireString(
      { command: launch.command ?? preset.command },
      "command",
    );
    if (!command.trim() || command.includes("\0"))
      throw new RpcError("INVALID_PARAMS", "Invalid agent executable");
    const args = strings(launch.args ?? [...preset.args]);
    const child = spawn(command, args, {
      cwd: this.files.root,
      env: process.env,
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    trackChild(child);
    const agent: Agent = {
      owner,
      child,
      connection: {
        id: randomUUID(),
        provider: preset.id,
        root: this.files.root,
        authMethods: [],
      },
      pending: new Map(),
      approvals: new Map(),
      terminals: new Map(),
      buffer: "",
      busy: false,
      stopped: false,
      sequence: 0,
      turn: 0,
    };
    this.agents.set(agent.connection.id, agent);
    const abort = () => this.stopAgent(agent, "Agent connection cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", (error) => this.stopAgent(agent, error.message));
    child.on("error", (error) =>
      this.stopAgent(
        agent,
        `Could not launch ${command}: ${error.message}. Check the executable and setup instructions.`,
      ),
    );
    child.on("close", (code, signal) =>
      this.stopAgent(agent, `Agent exited (${signal ?? code ?? "unknown"})`),
    );
    child.stderr.on("data", (data: string) =>
      this.publish(agent, "acp.log", { text: data.slice(-16384) }),
    );
    child.stdout.on("data", (data: string) => {
      agent.buffer += data;
      let end: number;
      while ((end = agent.buffer.indexOf("\n")) >= 0) {
        const line = agent.buffer.slice(0, end);
        agent.buffer = agent.buffer.slice(end + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 2 * MAX_BYTES) {
          this.stopAgent(agent, "ACP message exceeds 2 MiB");
          return;
        }
        try {
          const message = JSON.parse(line);
          if (message?.jsonrpc !== "2.0")
            throw new Error("Invalid ACP envelope");
          void this.message(agent, message).catch((error) =>
            this.stopAgent(agent, String(error)),
          );
        } catch {
          this.stopAgent(
            agent,
            "Agent stdout must contain newline-delimited ACP JSON-RPC messages",
          );
          return;
        }
      }
      if (Buffer.byteLength(agent.buffer) > 2 * MAX_BYTES)
        this.stopAgent(agent, "ACP message exceeds 2 MiB");
    });
    try {
      const initialized = await this.request(agent, "initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "oxbit", title: "Oxbit", version: "0.1.0" },
      });
      if (initialized.protocolVersion !== 1)
        throw new Error("Agent does not support ACP version 1");
      agent.connection.authMethods = initialized.authMethods ?? [];
      agent.connection.capabilities = initialized.agentCapabilities ?? {};
      agent.connection.agentInfo = initialized.agentInfo;
      return agent.connection;
    } catch (error) {
      this.stopAgent(agent, String(error));
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async call(
    owner: string,
    id: string,
    method: string,
    params: Params = {},
    signal?: AbortSignal,
  ) {
    const agent = this.get(owner, id);
    if (agent.busy)
      throw new RpcError(
        "BUSY",
        "Wait for the current agent operation or stop it first",
      );
    if (method === "authenticate") {
      if (!agent.connection.authMethods.some((m) => m.id === params.methodId))
        throw new RpcError("INVALID_PARAMS", "Unknown authentication method");
      agent.busy = true;
      try {
        return await this.request(
          agent,
          method,
          { methodId: params.methodId },
          300000,
        );
      } finally {
        agent.busy = false;
      }
    }
    if (method === "session/list") {
      if (!agent.connection.capabilities?.sessionCapabilities?.list)
        throw new Error("This agent does not support conversation discovery");
      agent.busy = true;
      try {
        const result = await this.request(agent, method, {
          cwd: this.files.root,
          ...(params.cursor === undefined
            ? {}
            : { cursor: requireString(params, "cursor") }),
        });
        if (!Array.isArray(result?.sessions))
          throw new Error("Invalid conversation list");
        return {
          sessions: result.sessions
            .filter(
              (s: any) =>
                typeof s.sessionId === "string" &&
                typeof s.cwd === "string" &&
                path.resolve(s.cwd) === this.files.root,
            )
            .slice(0, 200),
          nextCursor:
            typeof result.nextCursor === "string"
              ? result.nextCursor
              : undefined,
        };
      } finally {
        agent.busy = false;
      }
    }
    if (["session/new", "session/load", "session/resume"].includes(method)) {
      if (
        method === "session/load" &&
        !agent.connection.capabilities?.loadSession
      )
        throw new Error("This agent does not support loading conversations");
      if (
        method === "session/resume" &&
        !agent.connection.capabilities?.sessionCapabilities?.resume
      )
        throw new Error("This agent does not support resuming conversations");
      const previous = { ...agent.connection };
      const target =
        method === "session/new"
          ? undefined
          : requireString(params, "sessionId");
      if (agent.approvals.size)
        throw new Error(
          "Resolve pending requests before changing conversations",
        );
      agent.busy = true;
      // Load replays history before its response. Route only the requested session.
      agent.connection.sessionId = target;
      if (!target) agent.newSessionUpdates = [];
      try {
        const result = await this.request(agent, method, {
          cwd: this.files.root,
          mcpServers: [],
          ...(target ? { sessionId: target } : {}),
        });
        const sessionId = target ?? result?.sessionId;
        if (typeof sessionId !== "string" || !sessionId)
          throw new Error("Agent returned an invalid session ID");
        Object.assign(agent.connection, {
          sessionId,
          modes: result?.modes,
          models: result?.models,
          configOptions: result?.configOptions,
        });
        for (const params of agent.newSessionUpdates ?? [])
          if (params.sessionId === sessionId)
            this.publish(agent, "acp.update", {
              sessionId,
              update: params.update,
            });
        for (const terminal of agent.terminals.values())
          killProcess(terminal.child);
        agent.terminals.clear();
        return agent.connection;
      } catch (error) {
        Object.assign(agent.connection, previous);
        throw error;
      } finally {
        agent.newSessionUpdates = undefined;
        agent.busy = false;
      }
    }
    if (!agent.connection.sessionId)
      throw new Error("Start a conversation first");
    const sessionId = agent.connection.sessionId;
    if (
      [
        "session/set_mode",
        "session/set_model",
        "session/set_config_option",
      ].includes(method)
    ) {
      const values =
        method === "session/set_mode"
          ? { modeId: requireString(params, "modeId") }
          : method === "session/set_model"
            ? { modelId: requireString(params, "modelId") }
            : {
                configId: requireString(params, "configId"),
                value: requireString(params, "value"),
              };
      agent.busy = true;
      try {
        const result = await this.request(agent, method, {
          sessionId,
          ...values,
        });
        if (result?.configOptions)
          agent.connection.configOptions = result.configOptions;
        if (method === "session/set_mode" && agent.connection.modes)
          agent.connection.modes.currentModeId = values.modeId!;
        if (method === "session/set_model" && agent.connection.models)
          agent.connection.models.currentModelId = values.modelId!;
        return result;
      } finally {
        agent.busy = false;
      }
    }
    if (method !== "session/prompt")
      throw new RpcError("INVALID_PARAMS", "Unsupported ACP client method");
    const text = requireString(params, "text", MAX_BYTES);
    if (!text.trim()) throw new Error("Enter a message");
    const prompt: Params[] = [{ type: "text", text }];
    if (params.context !== undefined) {
      if (!Array.isArray(params.context) || params.context.length > 8)
        throw new Error("Attach up to eight context items");
      for (const item of params.context) {
        const content = requireString(item, "text", 200000);
        const relative = requireString(item, "path");
        const absolute = await this.files.resolve(relative);
        const label =
          typeof item.label === "string" ? item.label.slice(0, 1024) : relative;
        if (agent.connection.capabilities?.promptCapabilities?.embeddedContext)
          prompt.push({
            type: "resource",
            resource: {
              uri:
                pathToFileURL(absolute).href +
                (Number.isSafeInteger(item.line) ? `#L${item.line}` : ""),
              mimeType: "text/plain",
              text: `Editor snapshot: ${label}\n${content}`,
            },
          });
        else
          prompt.push({
            type: "text",
            text: `Attached editor context: ${label}\n${content}`,
          });
      }
    }
    if (Buffer.byteLength(JSON.stringify(prompt)) > MAX_BYTES)
      throw new Error("The message and attachments are too large");
    // Resolving attached paths yields; another request may have taken this connection.
    if (agent.busy || agent.stopped || agent.connection.sessionId !== sessionId)
      throw new Error("Agent connection is busy or ended");
    agent.busy = true;
    agent.turn++;
    const abort = () => this.stopAgent(agent, "Agent request interrupted");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.request(
        agent,
        method,
        { sessionId, prompt },
        30 * 60 * 1000,
      );
    } finally {
      agent.busy = false;
      signal?.removeEventListener("abort", abort);
    }
  }
  cancel(owner: string, id: string) {
    const agent = this.get(owner, id);
    this.send(agent, {
      method: "session/cancel",
      params: { sessionId: agent.connection.sessionId },
    });
    for (const [requestId, request] of agent.approvals) {
      this.send(agent, {
        id: request.rpcId,
        ...(request.method === "session/request_permission"
          ? { result: { outcome: { outcome: "cancelled" } } }
          : { error: { code: -32800, message: "Cancelled" } }),
      });
      agent.approvals.delete(requestId);
    }
    for (const terminal of agent.terminals.values())
      killProcess(terminal.child);
    this.publish(agent, "acp.cancelled", {});
    // A compliant agent completes session/prompt with stopReason=cancelled. Bound noncompliant agents.
    const turn = agent.turn;
    const timer = setTimeout(() => {
      if (agent.busy && agent.turn === turn)
        this.stopAgent(
          agent,
          "Agent did not finish cancellation; reconnect to continue",
        );
    }, 5000);
    timer.unref();
    return {};
  }
  private async relative(value: unknown, missing = false) {
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new RpcError(
        "PATH_DENIED",
        "ACP paths must be absolute workspace paths",
      );
    const relative = path
      .relative(this.files.root, value)
      .split(path.sep)
      .join("/");
    await this.files.resolve(relative, missing);
    return relative;
  }
  private async message(agent: Agent, message: Params) {
    if (agent.stopped) return;
    if (!message.method) {
      const pending = agent.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      agent.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new RpcError(
            String(message.error.code),
            message.error.message ?? "ACP request failed",
            message.error.data,
          ),
        );
      else pending.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (message.id === undefined) {
      if (message.method === "session/update" && agent.newSessionUpdates) {
        if (agent.newSessionUpdates.length >= 100)
          throw new Error("Too many updates while creating a session");
        agent.newSessionUpdates.push(params);
        return;
      }
      if (
        message.method === "session/update" &&
        (!agent.connection.sessionId ||
          params.sessionId === agent.connection.sessionId)
      )
        this.publish(agent, "acp.update", {
          sessionId: params.sessionId,
          update: params.update,
        });
      else if (message.method.startsWith("cursor/"))
        this.publish(agent, "acp.update", {
          update: { sessionUpdate: message.method, ...params },
        });
      return;
    }
    try {
      const requiresSession =
        message.method.startsWith("fs/") ||
        message.method.startsWith("terminal/") ||
        message.method === "session/request_permission";
      if (
        (requiresSession || params.sessionId !== undefined) &&
        (!agent.connection.sessionId ||
          params.sessionId !== agent.connection.sessionId)
      )
        throw new Error("Unknown ACP session");
      if (message.method.startsWith("terminal/")) {
        const result = await this.terminal(agent, message.method, params);
        this.send(agent, { id: message.id, result });
        return;
      }
      if (
        ![
          "fs/read_text_file",
          "fs/write_text_file",
          "session/request_permission",
          "cursor/ask_question",
          "cursor/create_plan",
        ].includes(message.method)
      ) {
        this.send(agent, {
          id: message.id,
          error: { code: -32601, message: "Client method is not supported" },
        });
        return;
      }
      if (agent.approvals.size >= 32)
        throw new Error("Too many pending agent requests");
      if (message.method.startsWith("fs/")) {
        params.path = await this.relative(
          params.path,
          message.method === "fs/write_text_file",
        );
        for (const field of ["line", "limit"])
          if (
            params[field] !== undefined &&
            (!Number.isSafeInteger(params[field]) || params[field] < 1)
          )
            throw new Error(`Invalid ${field}`);
        if (message.method === "fs/write_text_file")
          requireString(params, "content", MAX_BYTES);
      }
      if (agent.stopped) return;
      const requestId = randomUUID();
      agent.approvals.set(requestId, {
        rpcId: message.id,
        method: message.method,
        params,
      });
      this.publish(agent, "acp.request", {
        requestId,
        method: message.method,
        params,
      });
    } catch (error) {
      if (!agent.stopped)
        this.send(agent, {
          id: message.id,
          error: { code: -32603, message: String(error) },
        });
    }
  }
  respond(
    owner: string,
    id: string,
    requestId: string,
    result: unknown,
    error?: string,
  ) {
    const agent = this.get(owner, id),
      request = agent.approvals.get(requestId);
    if (!request) throw new Error("Agent request has expired");
    if (!error && request.method === "session/request_permission") {
      const outcome = (result as any)?.outcome;
      if (
        outcome?.outcome !== "cancelled" &&
        !(
          outcome?.outcome === "selected" &&
          request.params.options?.some(
            (o: any) => o.optionId === outcome.optionId,
          )
        )
      )
        throw new Error("Invalid permission response");
    }
    this.send(agent, {
      id: request.rpcId,
      ...(error
        ? { error: { code: -32603, message: error.slice(0, 4096) } }
        : { result }),
    });
    agent.approvals.delete(requestId);
    return {};
  }
  private async terminal(
    agent: Agent,
    method: string,
    params: Params,
  ): Promise<unknown> {
    if (method === "terminal/create") {
      if (agent.terminals.size >= 16)
        throw new Error("Agent terminal limit reached");
      const cwd = params.cwd
        ? await this.files.resolve(await this.relative(params.cwd))
        : this.files.root;
      const command = requireString(params, "command");
      if (!command || command.includes("\0"))
        throw new Error("Invalid terminal command");
      const env = { ...process.env };
      if (params.env !== undefined) {
        if (!Array.isArray(params.env) || params.env.length > 128)
          throw new Error("Invalid terminal environment");
        for (const entry of params.env) {
          const name = requireString(entry, "name"),
            value = requireString(entry, "value", 16384);
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || value.includes("\0"))
            throw new Error("Invalid environment variable");
          env[name] = value;
        }
      }
      const limit = params.outputByteLimit ?? MAX_BYTES;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BYTES)
        throw new Error(
          "Terminal output limit must be between 1 and 1048576 bytes",
        );
      if (agent.stopped) throw new Error("Agent connection has ended");
      const child = spawn(command, strings(params.args ?? []), {
        cwd,
        env,
        stdio: "pipe",
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      trackChild(child);
      child.stdin.end();
      const terminalId = randomUUID();
      const terminal: Terminal = {
        child,
        limit,
        output: "",
        truncated: false,
        exited: Promise.resolve(),
      };
      agent.terminals.set(terminalId, terminal);
      const publish = () =>
        this.publish(agent, "acp.terminal", {
          terminalId,
          command,
          output: terminal.output,
          truncated: terminal.truncated,
          exitStatus: terminal.exitStatus,
        });
      const append = (data: string) => {
        terminal.output += data;
        const bytes = Buffer.from(terminal.output);
        if (bytes.length > limit) {
          let start = bytes.length - limit;
          while (start < bytes.length && (bytes[start] & 0xc0) === 0x80)
            start++;
          terminal.output = bytes.subarray(start).toString("utf8");
          terminal.truncated = true;
        }
        publish();
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      terminal.exited = new Promise((resolve) => {
        const finish = (exitCode: number | null, signal: string | null) => {
          terminal.exitStatus = { exitCode, signal };
          publish();
          resolve(terminal.exitStatus);
        };
        child.on("error", (error) => {
          append(error.message);
          finish(1, null);
        });
        child.on("close", finish);
      });
      publish();
      return { terminalId };
    }
    const terminal = agent.terminals.get(params.terminalId);
    if (!terminal) throw new Error("Unknown agent terminal");
    if (method === "terminal/output")
      return {
        output: terminal.output,
        truncated: terminal.truncated,
        ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
      };
    if (method === "terminal/wait_for_exit") return terminal.exited;
    if (method === "terminal/kill" || method === "terminal/release") {
      killProcess(terminal.child);
      if (method === "terminal/release")
        agent.terminals.delete(params.terminalId);
      return {};
    }
    throw new Error("Unsupported terminal method");
  }
  private stopAgent(agent: Agent, reason: string) {
    if (agent.stopped) return;
    agent.stopped = true;
    for (const pending of agent.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    agent.pending.clear();
    agent.approvals.clear();
    for (const terminal of agent.terminals.values())
      killProcess(terminal.child);
    agent.terminals.clear();
    killProcess(agent.child);
    this.agents.delete(agent.connection.id);
    this.publish(agent, "acp.exit", { reason });
  }
  stop(owner: string, id: string) {
    this.stopAgent(this.get(owner, id), "Agent disconnected");
    return {};
  }
  disconnect(owner: string) {
    for (const agent of this.agents.values())
      if (agent.owner === owner)
        this.stopAgent(agent, "Agent client disconnected");
  }
  dispose() {
    for (const agent of this.agents.values())
      this.stopAgent(agent, "Agent tooling stopped");
  }
}
