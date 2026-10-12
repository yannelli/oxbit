/** The host's fetch. Node 24 and browsers pass the global `fetch`. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Secret storage owned by the host, for example `~/.oxbit/agent/auth.json` written with mode 0600. */
export interface AuthStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Runs `task` while holding a cross-process lock on `key`, so two processes do not both spend one rotating refresh token. */
  lock?<T>(key: string, task: () => Promise<T>): Promise<T>;
}

const ERROR_BODY_LIMIT = 65536;

/** Decoded text chunks of a response body. Cancels the body when the consumer stops early. */
export async function* textChunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** The response body as text, cut at 64 KiB. */
export async function bodyText(response: Response, limit = ERROR_BODY_LIMIT) {
  let text = "";
  for await (const chunk of textChunks(response.body)) {
    text += chunk;
    if (text.length >= limit) break;
  }
  return text.slice(0, limit);
}

/** An Error shaped like the SDK's AgentModelError. */
export const httpError = (status: number, body: string, message = `HTTP ${status}`) => Object.assign(new Error(message), { status, body });

export function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string) {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export const randomToken = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));
