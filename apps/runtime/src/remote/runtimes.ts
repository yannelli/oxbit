import * as fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { ControlError } from "@oxbit/sdk/tunnel";
import { workspaceDataDir } from "../branding.js";
import { liveDaemon, readRecord, running, type Daemon } from "../daemon.js";
import { localHost } from "../lan.js";

/** Folder runtimes as `oxbit [path]` manages them. */
export interface RuntimeLauncher {
  /** Reuses the live runtime for `root` or starts one. */
  ensure(root: string): Promise<Daemon>;
  /** Live runtimes recorded under the home folder. */
  list(): Promise<Daemon[]>;
}
/** Starts a runtime for `root` that records itself in `dataDir`. */
export type StartRuntime = (root: string, dataDir: string) => Promise<Daemon>;

/** Keeps per-folder data in `~/.oxbit/workspaces/<hash>`, as `oxbit [path]` does without OXBIT_DATA_DIR. */
export function cliLauncher(home: string, start: StartRuntime): RuntimeLauncher {
  const starting = new Map<string, Promise<Daemon>>();
  const workspaces = path.join(home, ".oxbit", "workspaces");
  return {
    ensure(root) {
      const pending = starting.get(root);
      if (pending) return pending;
      const dataDir = workspaceDataDir(root, home);
      const run = (async () => (await liveDaemon(dataDir)) ?? (await start(root, dataDir)))().finally(() => starting.delete(root));
      starting.set(root, run);
      return run;
    },
    async list() {
      const names = await fs.readdir(workspaces).catch(() => [] as string[]);
      const live = await Promise.all(
        names.map(async (name) => {
          const dataDir = path.join(workspaces, name);
          const record = await readRecord(dataDir);
          return record && running(record.pid) ? liveDaemon(dataDir) : undefined;
        }),
      );
      return live.filter((daemon): daemon is Daemon => daemon !== undefined);
    },
  };
}

export interface RuntimeSummary {
  id: string;
  name: string;
  version: string;
}
interface Pairing {
  token: string;
  runtime: RuntimeSummary;
}

const bracket = (host: string) => (host.includes(":") ? `[${host}]` : host);
const httpBase = (daemon: Daemon) => `http://${bracket(localHost(daemon.host))}:${daemon.port}`;
/** The runtime allows this origin on every bind address. */
export const loopbackOrigin = (daemon: Daemon) => `http://127.0.0.1:${daemon.port}`;

async function pair(daemon: Daemon): Promise<Pairing> {
  let response: Response;
  try {
    response = await fetch(`${httpBase(daemon)}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: loopbackOrigin(daemon) },
      body: JSON.stringify({ code: daemon.pairingCode }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new ControlError("RUNTIME_UNAVAILABLE", `The runtime for ${daemon.root} did not answer: ${(error as Error).message}`);
  }
  const body = (await response.json().catch(() => ({}))) as { token?: unknown; runtime?: Partial<RuntimeSummary>; error?: unknown };
  if (!response.ok || typeof body.token !== "string")
    throw new ControlError("RUNTIME_PAIRING_FAILED", `Pairing with the runtime for ${daemon.root} failed (${response.status}${body.error ? `: ${String(body.error)}` : ""})`);
  const runtime = body.runtime ?? {};
  return {
    token: body.token,
    runtime: { id: String(runtime.id ?? daemon.id ?? ""), name: String(runtime.name ?? ""), version: String(runtime.version ?? "") },
  };
}

/** Starts or reuses folder runtimes, pairs once per runtime, and opens loopback sockets to them. */
export class RuntimeBridge {
  private readonly pairings = new Map<string, Promise<Pairing>>();

  constructor(readonly launcher: RuntimeLauncher) {}

  async open(root: string): Promise<{ daemon: Daemon } & Pairing> {
    let daemon: Daemon;
    try {
      daemon = await this.launcher.ensure(root);
    } catch (error) {
      throw new ControlError("RUNTIME_START_FAILED", (error as Error).message.split("\n")[0]!);
    }
    const key = daemon.id ?? `${daemon.root}\0${daemon.pid}`;
    let pairing = this.pairings.get(key);
    if (!pairing) {
      pairing = pair(daemon);
      this.pairings.set(key, pairing);
      pairing.catch(() => this.pairings.delete(key));
    }
    return { daemon, ...(await pairing) };
  }

  connect(daemon: Daemon): Promise<WebSocket> {
    const socket = new WebSocket(`${httpBase(daemon).replace(/^http/, "ws")}/ws`, {
      origin: loopbackOrigin(daemon),
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    });
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(socket));
      socket.once("error", (error) => reject(new ControlError("RUNTIME_UNAVAILABLE", `Cannot connect to the runtime for ${daemon.root}: ${error.message}`)));
    });
  }
}
