import type { Env } from "./cloudflare.js";
import { CONNECT_PATH, HOST_ID, HOST_PATH, PROTOCOL_VERSION } from "./protocol.js";
import { overLimit } from "./ratelimit.js";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true, protocol: PROTOCOL_VERSION }, 200);
  if (url.pathname !== HOST_PATH && url.pathname !== CONNECT_PATH) return json({ error: "NotFound" }, 404);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "UpgradeRequired" }, 426, { Upgrade: "websocket" });
  }
  const id = url.searchParams.get("id");
  if (!id || !HOST_ID.test(id)) return json({ error: "BadHostId" }, 400);
  const limiter = url.pathname === HOST_PATH ? env.HOST_LIMITER : env.CONNECT_LIMITER;
  if (await overLimit(limiter, request)) return json({ error: "RateLimited" }, 429);
  return env.HOSTS.get(env.HOSTS.idFromName(`host:${id}`)).fetch(request);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
