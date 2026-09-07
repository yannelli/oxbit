/** Private newline-framed parent protocol. stdout is exclusively protocol, never a log. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { observeOwnedProcesses, terminateOwnedProcesses } from "./owned-processes.js";
import { createRuntime } from "./runtime.js";

interface Launch {
  version: 1;
  type: "launch";
  root: string;
  dataDir: string;
  workspaceKey: string;
  token: string;
  rgPath: string;
  gitPath?: string;
  development?: boolean;
}
const send = (message: object) => process.stdout.write(JSON.stringify({ version: 1, ...message }) + "\n");
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let starting = false;
let stopping = false;
const deadline = setTimeout(() => void shutdown(1), 15000);
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  const force = setTimeout(() => { terminateOwnedProcesses(); process.exit(code); }, 4000);
  try { await runtime?.close(); }
  finally { clearTimeout(force); terminateOwnedProcesses(); process.exit(code); }
}
observeOwnedProcesses(send);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
// Bound input before readline can accumulate an unterminated message.
let bytes = 0;
process.stdin.on("data", (chunk: Buffer) => {
  bytes += chunk.length;
  if (bytes > 65536) void shutdown(1);
  if (chunk.includes(10)) bytes = 0;
});
lines.on("line", (line) => {
  void (async () => {
    const config = JSON.parse(line) as Launch | { version: 1; type: "shutdown" } | { version: 1; type: "rotate"; token: string; request: string };
    if (config.version !== 1) throw new Error("Unsupported supervisor protocol");
    if (config.type === "shutdown") { await shutdown(); return; }
    if (config.type === "rotate") {
      if (!runtime || typeof config.token !== "string" || config.token.length < 32) throw new Error("Invalid token rotation");
      await runtime.rotateDesktopToken(config.token);
      send({ type: "rotated", request: config.request });
      return;
    }
    if (config.type !== "launch" || starting) throw new Error("Expected one launch frame");
    starting = true;
    for (const value of [config.root, config.dataDir, config.rgPath])
      if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Launch paths must be absolute");
    if (!/^[a-f0-9]{64}$/.test(config.workspaceKey) || typeof config.token !== "string" || config.token.length < 32)
      throw new Error("Invalid launch identity");
    const root = await fs.realpath(config.root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Workspace is not a directory");
    runtime = await createRuntime({
      root, dataDir: config.dataDir, host: "127.0.0.1", port: 0,
      origins: ["tauri://localhost", ...(config.development ? ["http://localhost:9280", "http://127.0.0.1:9280"] : [])],
      desktop: config,
    });
    if (stopping) { await runtime.close(); return; }
    clearTimeout(deadline);
    send({ type: "ready", port: runtime.port, workspaceKey: config.workspaceKey, root });
  })().catch(() => {
    // Never echo launch frames, environment, credentials, or arbitrary exception text.
    send({ type: "error", code: "STARTUP_FAILED", message: "Runtime startup failed. Check the project and packaged resources." });
    void shutdown(1);
  });
});
lines.on("close", () => void shutdown());
process.stdout.on("error", () => void shutdown(1));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
