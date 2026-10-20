import type { TunnelSession } from "./session.js";

/** The WebSocket members `RuntimeClient` uses; `TunnelSocket` implements them. */
export type WebSocketLike = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close" | "onopen" | "onmessage" | "onerror" | "onclose">;

export interface TunnelSocketEvent {
  type: string;
}
export interface TunnelMessageEvent extends TunnelSocketEvent {
  data: string;
}
export interface TunnelCloseEvent extends TunnelSocketEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export const CLOSE_NORMAL = 1000;
/** Reported when `open` fails, the socket closes while connecting, or the session ends. */
export const CLOSE_ABNORMAL = 1006;

/** WebSocket view of one tunnel stream. `open` runs on a later microtask and resolves to the stream number, such as from `host.open`. */
export class TunnelSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  onopen: ((event: TunnelSocketEvent) => void) | null = null;
  onmessage: ((event: TunnelMessageEvent) => void) | null = null;
  onerror: ((event: TunnelSocketEvent) => void) | null = null;
  onclose: ((event: TunnelCloseEvent) => void) | null = null;
  private state: number = TunnelSocket.CONNECTING;
  private streamId?: number;
  private detach: Array<() => void>;

  constructor(
    private readonly session: TunnelSession,
    open: () => Promise<number>,
  ) {
    this.detach = [session.on("close", (reason) => this.fail(reason))];
    void Promise.resolve()
      .then(open)
      .then(
        (stream) => this.opened(stream),
        (error: unknown) => this.fail(error instanceof Error ? error.message : String(error)),
      );
  }

  get readyState(): number {
    return this.state;
  }

  get bufferedAmount(): number {
    return this.session.bufferedAmount;
  }

  /** Set once `open` resolves. */
  get stream(): number | undefined {
    return this.streamId;
  }

  send(data: string): void {
    if (this.state === TunnelSocket.CONNECTING) throw new DOMException("TunnelSocket is still connecting", "InvalidStateError");
    if (this.state !== TunnelSocket.OPEN) return;
    void this.session.send(this.streamId!, data).catch(() => undefined);
  }

  /** Sends CLOSE for the stream; `onclose` follows on a microtask. Closing while connecting reports 1006 like a WebSocket. */
  close(code = CLOSE_NORMAL, reason = ""): void {
    if (this.state === TunnelSocket.CONNECTING) return this.fail(reason);
    if (this.state !== TunnelSocket.OPEN) return;
    this.state = TunnelSocket.CLOSING;
    void this.session.closeStream(this.streamId!, reason).catch(() => undefined);
    queueMicrotask(() => this.finish(code, reason, true));
  }

  private opened(stream: number): void {
    if (this.state !== TunnelSocket.CONNECTING) {
      if (!this.session.closed) void this.session.closeStream(stream, "closed").catch(() => undefined);
      return;
    }
    this.streamId = stream;
    this.detach.push(
      this.session.on("message", (from, data) => {
        if (from === stream && this.state === TunnelSocket.OPEN) this.onmessage?.({ type: "message", data });
      }),
      this.session.on("streamClosed", (from, reason) => {
        if (from === stream) this.finish(CLOSE_NORMAL, reason, true);
      }),
    );
    this.state = TunnelSocket.OPEN;
    this.onopen?.({ type: "open" });
  }

  private fail(reason: string): void {
    if (this.state === TunnelSocket.CLOSED) return;
    if (this.state === TunnelSocket.CONNECTING) this.onerror?.({ type: "error" });
    this.finish(CLOSE_ABNORMAL, reason, false);
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.state === TunnelSocket.CLOSED) return;
    this.state = TunnelSocket.CLOSED;
    for (const detach of this.detach) detach();
    this.detach = [];
    this.onclose?.({ type: "close", code, reason, wasClean });
  }
}
