import { concatBytes, utf8Decode, utf8Encode, type Bytes } from "./encoding.js";
import { MAX_NOISE_MESSAGE } from "./noise-cipher.js";
import type { TransportCiphers } from "./noise-handshake.js";

export const FLAG_FIN = 0x01;
export const FLAG_CLOSE = 0x02;
/** Largest frame payload a sender writes. */
export const MAX_FRAGMENT = 65000;
export const CONTROL_STREAM = 0;
const HEADER = 5;
const EMPTY = new Uint8Array(0);

/** Byte channel under a session, such as a relay or LAN WebSocket. */
export interface TunnelTransport {
  send(bytes: Uint8Array): void;
  close?(reason: string): void;
}

export interface TunnelSessionEvents {
  message: (stream: number, text: string) => void;
  /** The peer sent CLOSE for `stream`. */
  streamClosed: (stream: number, reason: string) => void;
  error: (error: Error) => void;
  close: (reason: string) => void;
}

export interface TunnelSessionOptions {
  /** Largest reassembled message; a larger one fails the session. Defaults to 64 MiB. */
  maxMessageBytes?: number;
}

type Listeners = { [K in keyof TunnelSessionEvents]: Set<TunnelSessionEvents[K]> };

function encodeFrame(stream: number, flags: number, payload: Uint8Array): Bytes {
  if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff) throw new Error(`Invalid tunnel stream ${stream}`);
  if (payload.length > MAX_FRAGMENT) throw new Error("Tunnel frame payload exceeds 65000 bytes");
  const frame = new Uint8Array(HEADER + payload.length);
  new DataView(frame.buffer).setUint32(0, stream);
  frame[4] = flags;
  frame.set(payload, HEADER);
  return frame;
}

/** Noise transport over a byte channel, carrying framed UTF-8 messages on numbered streams. */
export class TunnelSession {
  readonly maxMessageBytes: number;
  private readonly listeners: Listeners = { message: new Set(), streamClosed: new Set(), error: new Set(), close: new Set() };
  private readonly partial = new Map<number, Bytes[]>();
  private readonly partialSize = new Map<number, number>();
  private outbound: Promise<void> = Promise.resolve();
  private inbound: Promise<void> = Promise.resolve();
  private queued = 0;
  private closeReason?: string;

  constructor(
    private readonly ciphers: TransportCiphers,
    private readonly transport: TunnelTransport,
    options: TunnelSessionOptions = {},
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? 64 * 1024 * 1024;
  }

  get closed(): boolean {
    return this.closeReason !== undefined;
  }

  /** Plaintext bytes waiting for encryption. */
  get bufferedAmount(): number {
    return this.queued;
  }

  get handshakeHash(): Bytes {
    return this.ciphers.handshakeHash;
  }

  on<K extends keyof TunnelSessionEvents>(event: K, listener: TunnelSessionEvents[K]): () => void {
    const listeners = this.listeners[event] as Set<TunnelSessionEvents[K]>;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Sends `text` as one message, split into fragments of at most 65000 bytes. */
  async send(stream: number, text: string): Promise<void> {
    const bytes = utf8Encode(text);
    const frames: Bytes[] = [];
    for (let offset = 0; ; offset += MAX_FRAGMENT) {
      const end = Math.min(offset + MAX_FRAGMENT, bytes.length);
      frames.push(encodeFrame(stream, end === bytes.length ? FLAG_FIN : 0, bytes.subarray(offset, end)));
      if (end === bytes.length) return this.enqueue(frames);
    }
  }

  async closeStream(stream: number, reason = ""): Promise<void> {
    this.dropPartial(stream);
    return this.enqueue([encodeFrame(stream, FLAG_CLOSE, utf8Encode(reason))]);
  }

  /** Feeds one binary message from the transport. Resolves once it is processed; failures close the session. */
  receive(data: Uint8Array | ArrayBuffer): Promise<void> {
    if (this.closed) return Promise.resolve();
    const message = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
    this.inbound = this.inbound.then(() => this.handle(message)).catch((error) => this.fail(error));
    return this.inbound;
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closeReason = reason;
    this.partial.clear();
    this.partialSize.clear();
    this.queued = 0;
    this.emit("close", reason);
    try {
      this.transport.close?.(reason);
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  private enqueue(frames: Bytes[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`Tunnel session is closed: ${this.closeReason}`));
    this.queued += frames.reduce((sum, frame) => sum + frame.length, 0);
    const run = this.outbound.then(async () => {
      for (const frame of frames) {
        if (this.closed) throw new Error(`Tunnel session is closed: ${this.closeReason}`);
        const message = await this.ciphers.send.encryptWithAd(EMPTY, frame);
        if (this.closed) throw new Error(`Tunnel session is closed: ${this.closeReason}`);
        this.queued -= frame.length;
        this.transport.send(message);
      }
    });
    this.outbound = run.catch((error) => this.fail(error));
    return run;
  }

  private async handle(message: Bytes): Promise<void> {
    if (this.closed) return;
    if (message.length > MAX_NOISE_MESSAGE) throw new Error("Tunnel message exceeds 65535 bytes");
    const frame = await this.ciphers.receive.decryptWithAd(EMPTY, message);
    if (this.closed) return;
    if (frame.length < HEADER) throw new Error("Tunnel frame is too short");
    const stream = new DataView(frame.buffer, frame.byteOffset).getUint32(0);
    const flags = frame[4];
    const payload = frame.subarray(HEADER);
    if (flags === FLAG_CLOSE) {
      this.dropPartial(stream);
      this.emit("streamClosed", stream, utf8Decode(payload));
      return;
    }
    if (flags & ~FLAG_FIN) throw new Error(`Unknown tunnel frame flags ${flags}`);
    const chunks = this.partial.get(stream) ?? [];
    const size = (this.partialSize.get(stream) ?? 0) + payload.length;
    if (size > this.maxMessageBytes) throw new Error(`Tunnel message on stream ${stream} exceeds ${this.maxMessageBytes} bytes`);
    chunks.push(payload);
    if (!(flags & FLAG_FIN)) {
      this.partial.set(stream, chunks);
      this.partialSize.set(stream, size);
      return;
    }
    this.dropPartial(stream);
    this.emit("message", stream, utf8Decode(concatBytes(...chunks)));
  }

  private dropPartial(stream: number): void {
    this.partial.delete(stream);
    this.partialSize.delete(stream);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.emit("error", failure);
    this.close(failure.message);
  }

  /** A throwing listener is reported as an `error` event and does not stop delivery. */
  private emit<K extends keyof TunnelSessionEvents>(event: K, ...args: Parameters<TunnelSessionEvents[K]>): void {
    for (const listener of [...this.listeners[event]]) {
      try {
        (listener as (...values: Parameters<TunnelSessionEvents[K]>) => void)(...args);
      } catch (error) {
        if (event !== "error") this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
