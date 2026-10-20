import { WebSocket } from "ws";
import { base64urlDecode, base64urlEncode, concatBytes, signRelayChallenge, type KeyPair } from "@oxbit/sdk/tunnel";
import { toBytes, type AcceptLink, type DeviceLink, type LinkHandler } from "./link.js";
import type { Logger } from "./state.js";

export type RelayState = "connecting" | "connected" | "offline" | "replaced" | "stopped";
export const CLOSE_REPLACED = 4409;
const CONNECTION_ID_BYTES = 16;

export interface RelayOptions {
  url: string;
  hostId: string;
  admission: KeyPair;
  accept: AcceptLink;
  log: Logger;
  /** Reconnect delay before jitter: `baseMs * 2^attempt`, capped at `maxMs`. */
  backoff?: { baseMs: number; maxMs: number };
  pingMs?: number;
  authTimeoutMs?: number;
}

export const hostSocketUrl = (relay: string, hostId: string) => `${relay.replace(/\/+$/, "")}/v1/host?id=${encodeURIComponent(hostId)}`;

/** Full jitter over the upper half of the capped exponential delay. */
export function reconnectDelay(attempt: number, baseMs: number, maxMs: number, random = Math.random) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** The host socket on the relay: authenticates, then carries every relayed device connection. */
export class RelayLink {
  state: RelayState = "offline";
  private socket?: WebSocket;
  private readonly links = new Map<string, LinkHandler>();
  private attempt = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly backoff: { baseMs: number; maxMs: number };

  constructor(private readonly options: RelayOptions) {
    this.backoff = options.backoff ?? { baseMs: 1000, maxMs: 60_000 };
  }

  get url() {
    return this.options.url;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.state = "stopped";
    clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = undefined;
    this.dropLinks();
    socket?.close(1000, "host stopping");
  }

  private connect() {
    if (this.stopped) return;
    this.state = "connecting";
    const { log } = this.options;
    const socket = new WebSocket(hostSocketUrl(this.options.url, this.options.hostId), {
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
      maxPayload: 2 * 1024 * 1024,
    });
    this.socket = socket;
    let failure = "";
    let lastMessage = Date.now();
    const pingMs = this.options.pingMs ?? 30_000;
    const ping = setInterval(() => {
      if (Date.now() - lastMessage > pingMs * 3) return socket.terminate();
      if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, pingMs);
    const auth = setTimeout(() => {
      failure = "authentication timed out";
      socket.terminate();
    }, this.options.authTimeoutMs ?? 15_000);
    socket.on("message", (data, binary) => {
      lastMessage = Date.now();
      if (binary) this.binary(toBytes(data));
      else
        void this.text(socket, data.toString(), () => clearTimeout(auth)).catch((error: Error) => {
          log(`Relay message failed: ${error.message}`);
        });
    });
    socket.on("error", (error) => {
      failure = error.message;
    });
    socket.on("close", (code, reason) => {
      clearInterval(ping);
      clearTimeout(auth);
      this.dropped(socket, code, reason.toString() || failure);
    });
  }

  private async text(socket: WebSocket, text: string, authenticated: () => void) {
    if (text === "pong" || socket !== this.socket) return;
    let message: { t?: unknown; nonce?: unknown; c?: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const { admission, hostId, log } = this.options;
    if (message.t === "challenge" && typeof message.nonce === "string") {
      const sig = await signRelayChallenge(admission.privateKey, hostId, message.nonce);
      this.sendText(socket, { t: "auth", key: base64urlEncode(admission.publicKey), sig });
    } else if (message.t === "ready") {
      authenticated();
      this.state = "connected";
      this.attempt = 0;
      log(`Relay connected: ${this.options.url}`);
    } else if (message.t === "open" && typeof message.c === "string") {
      this.open(socket, message.c);
    } else if (message.t === "closed" && typeof message.c === "string") {
      const handler = this.links.get(message.c);
      this.links.delete(message.c);
      handler?.closed();
    }
  }

  private open(socket: WebSocket, connection: string) {
    let prefix: Uint8Array;
    try {
      prefix = base64urlDecode(connection);
    } catch {
      return;
    }
    if (prefix.length !== CONNECTION_ID_BYTES) return;
    const link: DeviceLink = {
      path: "relay",
      send: (bytes) => {
        if (socket.readyState === WebSocket.OPEN && this.links.has(connection)) socket.send(concatBytes(prefix, bytes));
      },
      close: (reason) => {
        if (this.links.delete(connection)) this.sendText(socket, { t: "close", c: connection, reason });
      },
      established: () => {
        if (this.links.has(connection)) this.sendText(socket, { t: "established", c: connection });
      },
    };
    this.links.get(connection)?.closed();
    this.links.set(connection, this.options.accept(link));
  }

  private binary(bytes: Uint8Array) {
    if (bytes.length < CONNECTION_ID_BYTES) return;
    const connection = base64urlEncode(bytes.subarray(0, CONNECTION_ID_BYTES));
    this.links.get(connection)?.receive(bytes.subarray(CONNECTION_ID_BYTES));
  }

  private sendText(socket: WebSocket, message: object) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private dropLinks() {
    const handlers = [...this.links.values()];
    this.links.clear();
    for (const handler of handlers) handler.closed();
  }

  private dropped(socket: WebSocket, code: number, reason: string) {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.dropLinks();
    if (this.stopped) return;
    const { log, hostId } = this.options;
    if (code === CLOSE_REPLACED) {
      this.state = "replaced";
      log(`Relay closed this host with 4409: another host process authenticated as ${hostId}. Stopped reconnecting to the relay; LAN access continues. Restart this host to take the relay back.`);
      return;
    }
    this.state = "offline";
    const wait = reconnectDelay(this.attempt++, this.backoff.baseMs, this.backoff.maxMs);
    log(`Relay disconnected (${code}${reason ? ` ${reason}` : ""}); reconnecting in ${(wait / 1000).toFixed(1)}s`);
    this.retry = setTimeout(() => this.connect(), wait);
    this.retry.unref?.();
  }
}
