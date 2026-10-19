import { CONTROL_STREAM, type TunnelSession } from "./session.js";

export const CONTROL_TIMEOUT_MS = 30_000;

export interface ControlErrorBody {
  code: string;
  message: string;
}

/** A control request failed: the peer's `{code, message}`, or `TIMEOUT` / `CLOSED` locally. */
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

/** Return value becomes `result`; a thrown error with a string `code` becomes `error`, otherwise `INTERNAL`. */
export type ControlHandler = (params: any) => unknown;
export type ControlListener = (params: any) => void;

export interface ControlChannelOptions {
  /** Default request timeout. */
  timeoutMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: ControlError): void;
  timer: ReturnType<typeof setTimeout>;
}

function errorBody(error: unknown): ControlErrorBody {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    code: typeof code === "string" ? code : "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** JSON requests, responses, and events on stream 0. */
export class ControlChannel {
  readonly timeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly handlers = new Map<string, ControlHandler>();
  private readonly listeners = new Map<string, Set<ControlListener>>();
  private readonly detach: Array<() => void>;
  private nextId = 0;

  constructor(
    readonly session: TunnelSession,
    options: ControlChannelOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
    this.detach = [
      session.on("message", (stream, text) => {
        if (stream === CONTROL_STREAM) this.dispatch(text);
      }),
      session.on("close", (reason) => this.rejectAll(`Tunnel closed: ${reason}`)),
    ];
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const id = String(++this.nextId);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, new ControlError("TIMEOUT", `${method} timed out after ${timeoutMs} ms`)), timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, params }).catch((error: Error) => this.settle(id, new ControlError("CLOSED", error.message)));
    });
  }

  /** Serves `method` for the peer. Returns a function that removes the handler. */
  handle(method: string, handler: ControlHandler): () => void {
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method);
    };
  }

  emit(event: string, params: Record<string, unknown> = {}): Promise<void> {
    return this.write({ event, params });
  }

  on(event: string, listener: ControlListener): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, listeners.add(listener));
    return () => listeners.delete(listener);
  }

  /** Detaches from the session and rejects pending requests. */
  dispose(): void {
    for (const detach of this.detach) detach();
    this.rejectAll("Control channel disposed");
  }

  private write(message: object): Promise<void> {
    return this.session.send(CONTROL_STREAM, JSON.stringify(message));
  }

  private settle(id: string, outcome: { result: unknown } | ControlError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (outcome instanceof ControlError) pending.reject(outcome);
    else pending.resolve(outcome.result);
  }

  private rejectAll(message: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, new ControlError("CLOSED", message));
  }

  private dispatch(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (typeof message.event === "string") {
      for (const listener of [...(this.listeners.get(message.event) ?? [])]) listener(params);
    } else if (typeof message.id !== "string") {
      return;
    } else if (typeof message.method === "string") {
      void this.serve(message.id, message.method, params);
    } else if (message.error !== undefined) {
      const error = message.error as Partial<ControlErrorBody> | null;
      this.settle(message.id, new ControlError(String(error?.code ?? "INTERNAL"), String(error?.message ?? "")));
    } else {
      this.settle(message.id, { result: message.result });
    }
  }

  private async serve(id: string, method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(method);
    let reply: object;
    try {
      if (!handler) throw new ControlError("METHOD_NOT_FOUND", `Unknown control method ${method}`);
      reply = { id, result: (await handler(params)) ?? null };
    } catch (error) {
      reply = { id, error: errorBody(error) };
    }
    await this.write(reply).catch(() => undefined);
  }
}
