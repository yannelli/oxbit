import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { workspaceDataDir } from "./runtime.js";

export interface Daemon {
  pid: number;
  host: string;
  port: number;
  pairingCode: string;
  root: string;
  startedAt: number;
}
export type Environment = Record<string, string | undefined>;

export const dataDirFor = (root: string, env: Environment = process.env) =>
  env.ZAPP_DATA_DIR ? path.resolve(env.ZAPP_DATA_DIR) : workspaceDataDir(root);
export const recordFile = (dataDir: string) =>
  path.join(dataDir, "daemon.json");
export const logFile = (dataDir: string) => path.join(dataDir, "daemon.log");
export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function launchUrl(daemon: Daemon, file?: string) {
  const params = new URLSearchParams({ pair: daemon.pairingCode });
  if (file) params.set("open", file);
  return `http://${daemon.host}:${daemon.port}/#${params}`;
}

export function browserCommand(url: string, platform: string) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32")
    return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function launchBrowser(url: string) {
  const { command, args } = browserCommand(url, process.platform);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

// The record carries the pairing code, so it stays owner-readable inside the 0700 workspace data directory.
export const writeRecord = (dataDir: string, daemon: Daemon) =>
  fs.writeFile(recordFile(dataDir), JSON.stringify(daemon), { mode: 0o600 });
export const removeRecord = (dataDir: string) =>
  fs.rm(recordFile(dataDir), { force: true });

export async function readRecord(dataDir: string) {
  try {
    const record = JSON.parse(await fs.readFile(recordFile(dataDir), "utf8"));
    return typeof record?.pid === "number" &&
      typeof record?.port === "number" &&
      typeof record?.pairingCode === "string" &&
      typeof record?.host === "string" &&
      typeof record?.root === "string"
      ? (record as Daemon)
      : undefined;
  } catch {
    return undefined;
  }
}

export function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function serving(daemon: Daemon) {
  try {
    const response = await fetch(
      `http://${daemon.host}:${daemon.port}/api/health`,
      { signal: AbortSignal.timeout(2000) },
    );
    return response.ok && (await response.json())?.protocol === 1;
  } catch {
    return false;
  }
}

// An unrelated process can hold the recorded port once the daemon is gone, so liveness needs the health
// reply as well as the pid.
export async function liveDaemon(dataDir: string) {
  const daemon = await readRecord(dataDir);
  if (!daemon || !running(daemon.pid)) return undefined;
  return (await serving(daemon)) ? daemon : undefined;
}

export async function available(host: string, port: number) {
  const probe = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, host, () => {
        probe.removeListener("error", reject);
        resolve();
      });
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}
