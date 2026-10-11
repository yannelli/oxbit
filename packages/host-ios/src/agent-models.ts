import { Channel } from "@tauri-apps/api/core";
import type { AgentModelEndpoint, AgentModelError, AgentModelRequest, AgentModels } from "@oxbit/sdk";
import { native, type AgentModelStreamEvent } from "./native.js";

function endpointArgs({ api, baseUrl }: AgentModelEndpoint) {
  return { api, baseUrl };
}

function bytes(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** OpenAI and Anthropic error bodies carry `error.message`. */
function detail(body: string) {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof message === "string" && message ? `: ${message}` : "";
  } catch {
    return "";
  }
}

function modelError(status: number, body: string): AgentModelError {
  return Object.assign(new Error(`The model API answered ${status}${detail(body)}`), { name: "AgentModelError", status, body });
}

/** `AgentModels` over the oxbit-files plugin, which reads the key from Keychain and sends the request with URLSession. */
export class IosAgentModels implements AgentModels {
  readonly keys = {
    has: async (endpoint: AgentModelEndpoint) =>
      (await native.agentModelsKey({ operation: "has", ...endpointArgs(endpoint) }))?.saved === true,
    save: async (endpoint: AgentModelEndpoint, key: string) => {
      await native.agentModelsKey({ operation: "save", ...endpointArgs(endpoint), key });
    },
    remove: async (endpoint: AgentModelEndpoint) => {
      await native.agentModelsKey({ operation: "remove", ...endpointArgs(endpoint) });
    },
  };

  /** Aborting `signal` or leaving the loop early cancels the native request; abort rethrows the signal's reason. */
  async *stream(request: AgentModelRequest, signal?: AbortSignal): AsyncGenerator<string, void, undefined> {
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const events: AgentModelStreamEvent[] = [];
    let wake = () => {};
    const channel = new Channel<AgentModelStreamEvent>((event) => {
      events.push(event);
      wake();
    });
    let state: "starting" | "running" | "done" = "starting";
    const cancel = () => {
      if (state !== "running") return;
      state = "done";
      void native.agentModelsCancel(id).catch(() => undefined);
    };
    const abort = () => {
      cancel();
      wake();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const decoder = new TextDecoder();
    try {
      await native.agentModelsStream({
        id,
        ...endpointArgs(request),
        method: request.method,
        path: request.path,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        channel,
      });
      state = "running";
      for (;;) {
        signal?.throwIfAborted();
        const event = events.shift();
        if (!event) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        if (event.type === "chunk") {
          const text = decoder.decode(bytes(event.data), { stream: true });
          if (text) yield text;
          continue;
        }
        state = "done";
        if (event.type === "failed") throw new Error(event.message);
        if (event.status < 200 || event.status >= 300) throw modelError(event.status, event.body ?? "");
        const rest = decoder.decode();
        if (rest) yield rest;
        return;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      cancel();
    }
  }
}
