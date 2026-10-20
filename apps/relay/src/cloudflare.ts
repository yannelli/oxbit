/** The parts of the Workers runtime API the relay uses; the repo does not install `@cloudflare/workers-types`. */

export interface RelaySocket {
  readonly readyState: number;
  accept?(): void;
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface DurableState {
  readonly storage: DurableStorage;
  acceptWebSocket(socket: RelaySocket, tags?: string[]): void;
  getWebSockets(tag?: string): RelaySocket[];
  setWebSocketAutoResponse(pair?: unknown): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableStub;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  HOSTS: DurableNamespace;
  HOST_LIMITER?: RateLimiter;
  CONNECT_LIMITER?: RateLimiter;
}

export const OPEN = 1;
