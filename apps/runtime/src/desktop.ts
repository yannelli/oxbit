/** Private newline-framed parent protocol. stdout is exclusively protocol, never a log. */
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { connectSsh } from "./ssh.js";
import { acquireRemoteWorkspace, RemoteWorkspaceBusy } from "./ssh-workspace.js";
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
  remoteRuntime?: boolean;
}
const send = (message: object) => process.stdout.write(JSON.stringify({ version: 1, ...message }) + "\n");
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let remote: Awaited<ReturnType<typeof connectSsh>> | undefined;
let connectingRemote = false;
let releaseRemoteWorkspace: (() => Promise<void>) | undefined;
const connectionAbort = new AbortController();
let starting = false;
let remoteLease: ReturnType<typeof setTimeout> | undefined;
let isRemoteRuntime = false;
const forwards = new Map<string, { resolve: (port: number) => void; reject: (error: Error) => void }>();
const forwardTaskPort = (host: string, port: number) => new Promise<number>((resolve, reject) => {
  const request = randomUUID();
  const timer = setTimeout(() => { forwards.delete(request); reject(new Error("SSH task port forwarding timed out")); }, 15000);
  forwards.set(request, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  send({ type: "taskForward", request, host, port });
});
const refreshRemoteLease = () => { clearTimeout(remoteLease); remoteLease = setTimeout(() => void shutdown(1), 75000); };
let stopping = false;
const deadline = setTimeout(() => void shutdown(1), 15000);
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  connectionAbort.abort();
  clearTimeout(deadline);
  clearTimeout(remoteLease);
  for (const pending of forwards.values()) pending.reject(new Error("SSH runtime is closing"));
  forwards.clear();
  const force = setTimeout(() => { terminateOwnedProcesses(); process.exit(code); }, 4000);
  try { await remote?.close(); await runtime?.close(); await releaseRemoteWorkspace?.(); }
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
    const config = JSON.parse(line) as Launch | { version: 1; type: "heartbeat" } | { version: 1; type: "shutdown" } | { version: 1; type: "rotate"; token: string; request: string } | { version: 1; type: "taskForwarded"; request: string; port?: number; error?: string };
    if (config.version !== 1) throw new Error("Unsupported supervisor protocol");
    if (config.type === "heartbeat") { if (isRemoteRuntime) refreshRemoteLease(); return; }
    if (config.type === "taskForwarded") {
      const pending = forwards.get(config.request); forwards.delete(config.request);
      if (pending) {
        if (Number.isInteger(config.port) && config.port! > 0 && config.port! < 65536) pending.resolve(config.port!);
        else pending.reject(new Error(config.error ?? "SSH task forwarding failed"));
      }
      return;
    }
    if (config.type === "shutdown") { await shutdown(); return; }
    if (config.type === "rotate") {
      if (remote) { remote.send(config); return; }
      if (!runtime || typeof config.token !== "string" || config.token.length < 32) throw new Error("Invalid token rotation");
      await runtime.rotateDesktopToken(config.token);
      send({ type: "rotated", request: config.request });
      return;
    }
    if (config.type !== "launch" || starting) throw new Error("Expected one launch frame");
    starting = true;
    if (typeof config.root === "string" && config.root.startsWith("ssh://") && !config.remoteRuntime) {
      connectingRemote = true;
      clearTimeout(deadline);
      const timeout = setTimeout(() => connectionAbort.abort(), 240000);
      try {
        remote = await connectSsh({ target: config.root, token: config.token, workspaceKey: config.workspaceKey,
          payloadDirectory: fileURLToPath(new URL("./remote/", import.meta.url)), development: config.development,
          signal: connectionAbort.signal, onFrame: send,
          onProgress: message => send({ type: "progress", message }),
        });
      } finally { clearTimeout(timeout); }
      if (stopping) { await remote.close(); return; }
      send({ type: "ready", port: remote.port, workspaceKey: config.workspaceKey, root: config.root, openFile: remote.openFile });
      void remote.closed.then(() => shutdown(1));
      return;
    }
    let openFile: string | undefined;
    if (config.remoteRuntime) {
      isRemoteRuntime = true;
      refreshRemoteLease();
      if (typeof config.root !== "string" || !config.root.startsWith("/")) throw new Error("Invalid remote path");
      const target = await fs.realpath(config.root.startsWith("/~/") ? path.join(os.homedir(), config.root.slice(3)) : config.root === "/~" ? os.homedir() : config.root);
      const info = await fs.stat(target);
      if (!info.isDirectory() && !info.isFile()) throw new Error("Remote target must be a folder or regular file");
      config.root = info.isDirectory() ? target : path.dirname(target);
      openFile = info.isFile() ? path.basename(target) : undefined;
      config.dataDir = path.join(os.homedir(), ".oxbit", "remote", "workspaces", createHash("sha256").update(config.root).digest("hex"));
      config.rgPath = fileURLToPath(new URL("./bin/rg", import.meta.url));
      config.gitPath = undefined;
    }
    for (const value of [config.root, config.dataDir, config.rgPath])
      if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Launch paths must be absolute");
    if (!/^[a-f0-9]{64}$/.test(config.workspaceKey) || typeof config.token !== "string" || config.token.length < 32)
      throw new Error("Invalid launch identity");
    const root = await fs.realpath(config.root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Workspace is not a directory");
    if (config.remoteRuntime) releaseRemoteWorkspace = await acquireRemoteWorkspace(config.dataDir);
    runtime = await createRuntime({
      root, dataDir: config.dataDir, host: "127.0.0.1", port: 0,
      origins: ["tauri://localhost", ...(config.development ? ["http://localhost:9280", "http://127.0.0.1:9280"] : [])],
      desktop: config,
      ...(config.remoteRuntime ? { forwardTaskPort } : {}),
    });
    if (stopping) { await runtime.close(); return; }
    clearTimeout(deadline);
    send({ type: "ready", port: runtime.port, workspaceKey: config.workspaceKey, root, openFile });
  })().catch((error: unknown) => {
    // Never echo launch frames, environment, credentials, or arbitrary exception text.
    send({ type: "error", code: "STARTUP_FAILED", message: connectionAbort.signal.aborted ? "SSH connection cancelled or timed out." : (connectingRemote && error instanceof Error || error instanceof RemoteWorkspaceBusy) ? error.message : "Runtime startup failed. Check the project path and packaged resources." });
    void shutdown(1);
  });
});
lines.on("close", () => void shutdown());
process.stdout.on("error", () => void shutdown(1));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
