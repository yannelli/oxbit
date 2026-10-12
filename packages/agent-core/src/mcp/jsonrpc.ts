export type JsonRpcId = string | number;
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}
export interface JsonRpcRequest extends JsonRpcMessage {
  id: JsonRpcId;
  method: string;
}

/** HeaderMismatch, MissingRequiredClientCapability and UnsupportedProtocolVersion from MCP 2026-07-28. */
export const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022]);

export class McpError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown, readonly status?: number) {
    super(message);
  }
  /** 401 or 403 from an HTTP server. */
  get auth() {
    return this.status === 401 || this.status === 403;
  }
}

export interface Transport {
  /** Sends a request and resolves with the response that has its id. `headers` adds HTTP headers where the transport has them. */
  request(message: JsonRpcRequest, signal?: AbortSignal, headers?: Record<string, string>): Promise<JsonRpcMessage>;
  /** Sends a notification, or a response to a server request. */
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  /** Server notifications and requests that arrive outside a pending response. */
  onmessage?: (message: JsonRpcMessage) => void;
  /** The connection ended without close(). */
  onclose?: (error: Error) => void;
}

export const isResponse = (message: JsonRpcMessage) => message.id !== undefined && message.id !== null && !message.method
  && ("result" in message || "error" in message);

/** Parses one JSON-RPC message or undefined. */
export function parseMessage(text: string): JsonRpcMessage | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) && value.jsonrpc === "2.0" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** An error from an MCP HTTP response body, if it is a JSON-RPC error. */
export function bodyError(text: string) {
  const message = parseMessage(text);
  return message?.error && typeof message.error.code === "number" ? message.error : undefined;
}

/** MCP header value encoding: plain visible ASCII as is, else `=?base64?<utf-8 base64>?=`. */
export function headerValue(value: string) {
  const plain = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/.test(value) && !(value.startsWith("=?base64?") && value.endsWith("?="));
  if (plain) return value;
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return `=?base64?${btoa(binary)}?=`;
}

/** Rejects after `ms` or when `signal` aborts. */
export function deadline<T>(work: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpError(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
    const abort = () => reject(new McpError(`${label} was cancelled`));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  });
}
