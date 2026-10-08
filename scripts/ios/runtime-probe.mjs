// Drives a runtime through the iOS tunnel the way the WebView does: authenticate, read a file,
// trust the workspace, and run one terminal command. Prints one JSON line.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const [url, token, file, command, expected] = process.argv.slice(2);
const { WebSocket } = createRequire(new URL("../../apps/runtime/package.json", import.meta.url))("ws");
const socket = new WebSocket(url.replace(/^http/, "ws") + "/ws", { origin: "tauri://localhost" });
const pending = new Map();
const output = [];
let sequence = 0;
const run = randomUUID();
const fail = (message) => { console.error(message); process.exit(1); };
setTimeout(() => fail("probe timed out"), 60000).unref();
socket.on("error", (error) => fail(String(error)));
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "event" && message.event === "terminal.data") output.push(message.params.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
  else entry.resolve(message.result);
});
const request = (method, params = {}) => new Promise((resolve, reject) => {
  // Unique per run: the runtime persists operation results by request id across launches.
  const id = `probe-${run}-${++sequence}`;
  pending.set(id, { method, resolve, reject });
  socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
});
await new Promise((resolve) => socket.once("open", resolve));
try {
  const session = await request("auth.authenticate", { token });
  const read = await request("fs.read", { path: file });
  await request("workspace.trust", { trusted: true });
  const terminal = await request("terminal.create", { cols: 80, rows: 24 });
  await request("terminal.input", { id: terminal.id, data: command + "\r" });
  const deadline = Date.now() + 30000;
  while (!output.join("").includes(expected)) {
    if (Date.now() > deadline) fail("terminal output did not arrive: " + JSON.stringify(output.join("").slice(-400)));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await request("terminal.kill", { id: terminal.id });
  console.log(JSON.stringify({ owner: session.owner, text: read.text, terminal: true }));
  socket.close();
  process.exit(0);
} catch (error) {
  fail(String(error));
}
