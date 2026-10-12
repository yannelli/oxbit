import { parseSSE } from "../sse.js";
import { bodyText, textChunks, type Fetch } from "../providers/http.js";
import { McpError, bodyError, headerValue, isResponse, parseMessage, type JsonRpcMessage, type JsonRpcRequest, type Transport } from "./jsonrpc.js";

const JSON_LIMIT = 8 * 1024 * 1024;
const NAMED = new Set(["tools/call", "resources/read", "prompts/get"]);

/** An McpError for a non-2xx response. 401 and 403 say that remote MCP OAuth is not supported. */
export async function responseError(response: Response) {
  const text = await bodyText(response).catch(() => "");
  const error = bodyError(text);
  if (response.status === 401 || response.status === 403)
    return new McpError(`The MCP server returned ${response.status} ${response.status === 401 ? "Unauthorized" : "Forbidden"}. Oxbit Agent does not support `
      + "MCP OAuth sign-in yet; add an Authorization header for this server in mcp.json.", error?.code, error?.data, response.status);
  const detail = error?.message ?? text.trim().slice(0, 300);
  return new McpError(`The MCP server returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, error?.code, error?.data, response.status);
}

async function* messages(response: Response) {
  for await (const event of parseSSE(textChunks(response.body))) {
    if (event.event && event.event !== "message") continue;
    const message = parseMessage(event.data);
    if (message) yield message;
  }
}

/** Streamable HTTP. Modern servers (2026-07-28) get Mcp-Method and Mcp-Name; legacy ones get Mcp-Session-Id. */
export class HttpTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;
  /** MCP-Protocol-Version for every request. */
  version?: string;
  legacy = false;
  sessionId?: string;
  private controllers = new Set<AbortController>();
  constructor(readonly url: string, private headers: Record<string, string>, private fetch: Fetch) {}
  private headersFor(message?: JsonRpcMessage, extra: Record<string, string> = {}) {
    const headers = new Headers(this.headers);
    headers.set("accept", message ? "application/json, text/event-stream" : "text/event-stream");
    if (message) headers.set("content-type", "application/json");
    if (this.version) headers.set("mcp-protocol-version", this.version);
    if (this.legacy && this.sessionId) headers.set("mcp-session-id", this.sessionId);
    if (!this.legacy && message?.method) {
      headers.set("mcp-method", message.method);
      const name = message.params?.name ?? message.params?.uri;
      if (NAMED.has(message.method) && typeof name === "string") headers.set("mcp-name", headerValue(name));
    }
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    return headers;
  }
  private async exchange<T>(init: RequestInit, signal: AbortSignal | undefined, use: (response: Response) => Promise<T>) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.controllers.add(controller);
    try {
      return await use(await this.fetch(this.url, { ...init, signal: controller.signal }));
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof McpError)) throw new McpError("The MCP request was cancelled");
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.controllers.delete(controller);
    }
  }
  request(message: JsonRpcRequest, signal?: AbortSignal, extra?: Record<string, string>) {
    const init = { method: "POST", headers: this.headersFor(message, extra), body: JSON.stringify(message) };
    return this.exchange(init, signal, async (response) => {
      if (this.legacy && message.method === "initialize") this.sessionId = response.headers.get("mcp-session-id") ?? undefined;
      if (!response.ok) throw await responseError(response);
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        for await (const reply of messages(response)) {
          if (isResponse(reply) && String(reply.id) === String(message.id)) return reply;
          this.onmessage?.(reply);
        }
        throw new McpError("The MCP server closed the stream without a response");
      }
      const body = parseJson(await bodyText(response, JSON_LIMIT));
      const reply = Array.isArray(body) ? body.find((item) => String(item?.id) === String(message.id)) : body;
      if (!reply || !isResponse(reply)) throw new McpError(`The MCP server sent no JSON-RPC response (HTTP ${response.status})`);
      return reply as JsonRpcMessage;
    });
  }
  send(message: JsonRpcMessage) {
    return this.exchange({ method: "POST", headers: this.headersFor(message), body: JSON.stringify(message) }, undefined, async (response) => {
      if (!response.ok) throw await responseError(response);
      await response.body?.cancel().catch(() => {});
    });
  }
  /** Legacy servers: opens the optional GET stream for server messages. Resolves false when the server has none (405). */
  async openStream() {
    const controller = new AbortController();
    this.controllers.add(controller);
    const response = await this.fetch(this.url, { method: "GET", headers: this.headersFor(), signal: controller.signal }).catch(() => undefined);
    if (!response?.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      await response?.body?.cancel().catch(() => {});
      this.controllers.delete(controller);
      return false;
    }
    void (async () => {
      try {
        for await (const message of messages(response)) this.onmessage?.(message);
      } catch {
        // The stream ended; list changes then show on the next request.
      }
      this.controllers.delete(controller);
    })();
    return true;
  }
  async close() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    if (!this.legacy || !this.sessionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    await this.fetch(this.url, { method: "DELETE", headers: this.headersFor(), signal: controller.signal })
      .then((response) => response.body?.cancel()).catch(() => {});
    clearTimeout(timer);
    this.sessionId = undefined;
  }
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new McpError("The MCP server sent invalid JSON");
  }
}

/** The deprecated HTTP+SSE transport (2024-11-05): a GET event stream plus POSTs to its `endpoint` URL. */
export class SseTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;
  private endpoint?: string;
  private closing = false;
  private controller = new AbortController();
  private pending = new Map<string, { resolve(message: JsonRpcMessage): void; reject(error: Error): void }>();
  constructor(readonly url: string, private headers: Record<string, string>, private fetch: Fetch) {}
  /** Opens the stream and waits for the `endpoint` event. */
  async start() {
    const headers = new Headers(this.headers);
    headers.set("accept", "text/event-stream");
    const response = await this.fetch(this.url, { method: "GET", headers, signal: this.controller.signal });
    if (!response.ok) throw await responseError(response);
    const events = parseSSE(textChunks(response.body))[Symbol.asyncIterator]();
    for (;;) {
      const { done, value } = await events.next();
      if (done) throw new McpError("The SSE stream closed before the endpoint event");
      if (value.event !== "endpoint") continue;
      const endpoint = new URL(value.data.trim(), this.url);
      if (endpoint.origin !== new URL(this.url).origin) throw new McpError("The SSE endpoint event points to another origin");
      this.endpoint = endpoint.toString();
      break;
    }
    void this.pump(events);
  }
  private async pump(events: AsyncIterator<{ event?: string; data: string }>) {
    let failure = "The SSE stream closed";
    try {
      for (;;) {
        const { done, value } = await events.next();
        if (done) break;
        const message = !value.event || value.event === "message" ? parseMessage(value.data) : undefined;
        const waiter = message && isResponse(message) ? this.pending.get(String(message.id)) : undefined;
        if (waiter) {
          this.pending.delete(String(message!.id));
          waiter.resolve(message!);
        } else if (message) this.onmessage?.(message);
      }
    } catch (error) {
      failure = `The SSE stream failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const waiter of this.pending.values()) waiter.reject(new McpError(failure));
    this.pending.clear();
    if (!this.closing) this.onclose?.(new McpError(failure));
  }
  private async post(message: JsonRpcMessage, signal?: AbortSignal) {
    if (!this.endpoint) throw new McpError("The SSE transport is not connected");
    const headers = new Headers(this.headers);
    headers.set("content-type", "application/json");
    const response = await this.fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify(message), signal });
    if (!response.ok) throw await responseError(response);
    await response.body?.cancel().catch(() => {});
  }
  request(message: JsonRpcRequest, signal?: AbortSignal) {
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const key = String(message.id);
      const abort = () => {
        if (this.pending.delete(key)) reject(new McpError("The MCP request was cancelled"));
      };
      this.pending.set(key, { resolve: (value) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      }, reject });
      signal?.addEventListener("abort", abort, { once: true });
      this.post(message).catch((error) => {
        if (this.pending.delete(key)) reject(error);
      });
    });
  }
  send(message: JsonRpcMessage) {
    return this.post(message);
  }
  async close() {
    this.closing = true;
    this.controller.abort();
  }
}
