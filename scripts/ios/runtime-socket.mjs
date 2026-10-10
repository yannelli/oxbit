// The runtime WebSocket as the iOS WebView opens it: `tauri://localhost` origin, owner token.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const { WebSocket } = createRequire(new URL("../../apps/runtime/package.json", import.meta.url))("ws");

export const fail = (message) => { console.error(message); process.exit(1); };

export async function until(check, what, limit = 30000) {
  const deadline = Date.now() + limit;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) fail(`${what} did not happen in ${limit} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function connect(url, token) {
  const socket = new WebSocket(url.replace(/^http/, "ws") + "/ws", { origin: "tauri://localhost" });
  const pending = new Map(), events = [];
  let operationEpoch;
  socket.on("error", (error) => fail(String(error)));
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "event") events.push(message);
    if (message.event === "operation.epoch") operationEpoch = message.params.epoch;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
    else entry.resolve(message.result);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const nonce = randomUUID();
    const id = operationEpoch ? `op:${operationEpoch}:${nonce}` : nonce;
    pending.set(id, { method, resolve, reject });
    socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
  });
  await new Promise((resolve) => socket.once("open", resolve));
  const session = await request("auth.authenticate", { token });
  operationEpoch = session.operationEpoch;
  return { socket, request, events, session };
}
