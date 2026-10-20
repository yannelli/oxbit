import os from "node:os";
import { parseArgs } from "node:util";
import { setting } from "../branding.js";
import type { Environment } from "../daemon.js";
import { RemoteHost } from "./host.js";
import { hostRunning, ipcRequest } from "./ipc.js";
import * as report from "./report.js";
import { cliLauncher, type StartRuntime } from "./runtimes.js";
import { serviceManager, type ServiceManager, type ServiceSpec } from "./service.js";
import * as state from "./state.js";

export const REMOTE_USAGE = `Remote access
  oxbit remote enable [--no-service] [--no-pair]
                       Start the remote access host now and at login, then pair
                       a device; --no-service skips the login item, --no-pair
                       returns once the host runs
  oxbit remote pair [--link]
                       Show a new pairing link (single use, expires after
                       2 minutes); --link prints the link without a QR code
  oxbit remote status  Host id, relay connection, LAN address, paired devices
  oxbit remote devices Paired devices with last-seen times
  oxbit remote revoke <device>
                       Remove a paired device by name or id prefix
  oxbit remote disable Stop the host and remove the login item; keys and
                       devices stay
  oxbit remote reset   New host keys; every device must pair again
  oxbit remote serve   Run the host in this terminal (the login item runs this)
      --json           Print one JSON object per line
`;

const COMMANDS = ["enable", "disable", "status", "pair", "devices", "revoke", "reset", "serve", "help"] as const;
export type RemoteCommand = (typeof COMMANDS)[number];
export interface RemoteInvocation {
  command: RemoteCommand;
  json: boolean;
  /** pair: print the link without a QR code. */
  link: boolean;
  /** enable: install the login item; off with --no-service or OXBIT_REMOTE_SERVICE=0. */
  service: boolean;
  /** enable: create an offer once the host runs; off with --no-pair. */
  pair: boolean;
  device?: string;
}

export function parseRemote(argv: string[], env: Environment = process.env): RemoteInvocation | { error: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        link: { type: "boolean" },
        "no-service": { type: "boolean" },
        "no-pair": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  const { values, positionals } = parsed;
  const command = (values.help ? "help" : (positionals[0] ?? "help")) as RemoteCommand;
  if (!COMMANDS.includes(command)) return { error: `Unknown remote command "${positionals[0]}"` };
  const rest = positionals.slice(values.help ? 0 : 1);
  if (command === "revoke" && rest.length !== 1) return { error: "oxbit remote revoke takes one device name or id prefix" };
  if (command !== "revoke" && command !== "help" && rest.length) return { error: `oxbit remote ${command} takes no arguments` };
  if (values.link && command !== "pair" && command !== "enable") return { error: "--link applies to pair and enable" };
  if ((values["no-service"] || values["no-pair"]) && command !== "enable") return { error: "--no-service and --no-pair apply to enable" };
  if (values.json && command === "serve") return { error: "serve writes to remote.log and takes no --json" };
  return {
    command,
    json: values.json === true,
    link: values.link === true,
    service: values["no-service"] !== true && setting("REMOTE_SERVICE", env) !== "0",
    pair: values["no-pair"] !== true,
    ...(command === "revoke" ? { device: rest[0] } : {}),
  };
}

export interface RemoteContext {
  /** The CLI entry the login item runs. */
  entry: string;
  /** Starts a folder runtime the way `oxbit [path]` does. */
  startRuntime: StartRuntime;
  env?: Environment;
  home?: string;
  /** Overrides the platform login item; null when none exists. */
  service?: ServiceManager | null;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  hostWaitMs?: number;
}

export function serviceSpec(paths: state.RemotePaths, env: Environment, entry: string): ServiceSpec {
  const pass: Record<string, string> = {};
  for (const key of ["PATH", "OXBIT_RELAY"]) if (env[key]) pass[key] = env[key]!;
  if (setting("REMOTE_DIR", env)) pass.OXBIT_REMOTE_DIR = paths.dir;
  return { program: [process.execPath, entry, "remote", "serve"], env: pass, log: paths.log };
}

async function waitFor(check: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function stopHost(paths: state.RemotePaths) {
  if (!(await hostRunning(paths.socket))) return;
  await ipcRequest(paths.socket, "stop").catch(() => undefined);
  await waitFor(async () => !(await hostRunning(paths.socket)), 10_000);
}

async function serve(paths: state.RemotePaths, env: Environment, home: string, context: RemoteContext) {
  await state.ensureState(paths, env);
  const log = state.fileLogger(paths.log);
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  let host: RemoteHost;
  try {
    host = await RemoteHost.start({ paths, env, home, launcher: cliLauncher(home, context.startRuntime), log, onStop: () => stop() });
  } catch (error) {
    const failure = error as Error & { code?: string };
    log(`Host did not start: ${failure.message}`);
    (context.stderr ?? ((text) => process.stderr.write(text)))(`${failure.message}\n`);
    // A second host exits 0 so the login item does not restart it in a loop.
    return failure.code === "HOST_RUNNING" ? 0 : 1;
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await stopped;
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await host.close();
  return 0;
}

async function enable(paths: state.RemotePaths, env: Environment, manager: ServiceManager | undefined, invocation: RemoteInvocation, context: RemoteContext, out: report.Output) {
  const { identity } = await state.ensureState(paths, env);
  if (invocation.service) {
    if (!manager) throw new Error('Login items are available on macOS and Linux. Run "oxbit remote enable --no-service" and keep "oxbit remote serve" running.');
    const spec = serviceSpec(paths, env, context.entry);
    const running = await hostRunning(paths.socket);
    if (!running || !(await manager.current(spec))) {
      await stopHost(paths);
      await manager.install(spec);
    }
    const waitMs = context.hostWaitMs ?? 15_000;
    if (!(await waitFor(() => hostRunning(paths.socket), waitMs)))
      throw new Error(`The remote access host did not start within ${waitMs / 1000}s. See ${paths.log}`);
  } else if (!(await hostRunning(paths.socket))) {
    if (out.json) out.object({ enabled: false, running: false, hostId: identity.id });
    else out.line(`Remote access is set up in ${paths.dir}. Start the host with "oxbit remote serve", then run "oxbit remote pair".`);
    return 0;
  }
  if (!invocation.pair) {
    const status = await ipcRequest(paths.socket, "status");
    if (out.json) out.object({ enabled: invocation.service, running: true, hostId: status.id, name: status.name });
    else out.line(`Remote access is on for "${status.name}" (${status.id}).`);
    return 0;
  }
  return report.pair(paths, out, invocation.link);
}

async function disable(paths: state.RemotePaths, manager: ServiceManager | undefined, out: report.Output) {
  const removed = manager ? await manager.uninstall() : false;
  await stopHost(paths);
  if (out.json) out.object({ enabled: false, running: await hostRunning(paths.socket) });
  else out.line(`Remote access is off${removed ? " and the login item is removed" : ""}. Host keys and paired devices stay in ${paths.dir}.`);
  return 0;
}

/** `oxbit remote <command>`; returns the exit code. */
export async function runRemote(argv: string[], context: RemoteContext): Promise<number> {
  const env = context.env ?? process.env;
  const home = context.home ?? os.homedir();
  const write = context.stdout ?? ((text) => process.stdout.write(text));
  const fail = context.stderr ?? ((text) => process.stderr.write(text));
  const invocation = parseRemote(argv, env);
  if ("error" in invocation) {
    fail(`${invocation.error}\n\n${REMOTE_USAGE}`);
    return 2;
  }
  const out: report.Output = {
    json: invocation.json,
    line: (text) => write(`${text}\n`),
    object: (value) => write(`${JSON.stringify(value)}\n`),
  };
  const paths = state.remotePaths(env, home);
  const manager = context.service === undefined ? serviceManager({ home, env }) : (context.service ?? undefined);
  try {
    switch (invocation.command) {
      case "help":
        write(REMOTE_USAGE);
        return 0;
      case "serve":
        return await serve(paths, env, home, context);
      case "enable":
        return await enable(paths, env, manager, invocation, context, out);
      case "disable":
        return await disable(paths, manager, out);
      case "pair":
        return await report.pair(paths, out, invocation.link);
      case "status":
        return await report.status(paths, env, manager, out);
      case "devices":
        return await report.devices(paths, out);
      case "revoke":
        return await report.revoke(paths, invocation.device!, out);
      case "reset":
        return await report.reset(paths, out);
    }
  } catch (error) {
    const failure = error as Error & { code?: unknown };
    if (out.json) out.object({ error: { code: typeof failure.code === "string" ? failure.code : "ERROR", message: failure.message } });
    else fail(`${failure.message}\n`);
    return 1;
  }
}
