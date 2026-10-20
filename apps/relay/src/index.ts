import type { DurableState, Env, RelaySocket } from "./cloudflare.js";
import { HostRelay, type RelayDeps } from "./host-object.js";
import { LIMITS } from "./protocol.js";
import { handleRequest } from "./worker.js";

declare global {
  const WebSocketPair: { new (): { 0: RelaySocket; 1: RelaySocket } };
  const WebSocketRequestResponsePair: { new (request: string, response: string): unknown };
}

export const workerdDeps: RelayDeps = {
  now: () => Date.now(),
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  socketPair: () => {
    const pair = new WebSocketPair();
    return [pair[0], pair[1]];
  },
  upgrade: (client) => new Response(null, { status: 101, webSocket: client } as ResponseInit),
  autoResponse: () => new WebSocketRequestResponsePair("ping", "pong"),
  limits: LIMITS,
};

export class RelayHost extends HostRelay {
  constructor(state: DurableState, _env: Env) {
    super(state, workerdDeps);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
