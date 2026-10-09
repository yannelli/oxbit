import * as fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRuntime } from "./runtime.js";
import { setting } from "./branding.js";
import { runtimeVersion } from "./version.js";
import { lanUrl, wildcardHost } from "./lan.js";
import { advertise, type Advertiser } from "./mdns.js";
import {
  dataDirFor,
  delay,
  launchBrowser,
  launchUrl,
  liveDaemon,
  logFile,
  removeRecord,
  running,
  writeRecord,
  type Daemon,
  type Environment,
} from "./daemon.js";

export const DEFAULT_HOST = "127.0.0.1";
const READY_TIMEOUT = 60000;
const STOP_TIMEOUT = 10000;

export const USAGE = `oxbit [options] [path]

Open a workspace in Oxbit. Starts a runtime for the workspace unless one is
already serving it, then opens the paired editor in the default browser.

  path                 File or directory to open (default: $OXBIT_WORKSPACE or .)

Options
  -p, --port <number>  Port to serve on (default: $PORT or a free port)
      --host <address> Address to bind (default: $HOST or ${DEFAULT_HOST})
      --lan            Serve on every network interface, allow the iOS app and
                       LAN origins, and advertise the runtime over Bonjour
      --desktop        Open in the installed Oxbit desktop application
      --no-open        Leave the browser closed
      --keep-alive <duration>
                       Stop after this long with no connected client: 75s, 15m,
                       1h, 8h, forever, or milliseconds (default:
                       $OXBIT_KEEP_ALIVE or forever)
  -f, --foreground     Serve in this terminal and stay attached
      --stop           Stop the runtime serving the workspace
      --status         Report the runtime serving the workspace
  -h, --help           Show this message
  -v, --version        Show the runtime version
`;

export interface Invocation {
  target: string;
  /** 0 asks the OS for a free port. */
  port: number;
  host: string;
  /** Bind every interface and advertise over Bonjour. */
  lan: boolean;
  open: boolean;
  foreground: boolean;
  /** Milliseconds without a connected client before the runtime stops; 0 runs until stopped. */
  keepAlive: number;
  action: "open" | "stop" | "status" | "help" | "version" | "desktop";
}
export interface Target {
  root: string;
  file?: string;
}

function tokenize(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        desktop: { type: "boolean" },
        port: { type: "string", short: "p" },
        host: { type: "string" },
        lan: { type: "boolean" },
        "no-open": { type: "boolean" },
        "keep-alive": { type: "string" },
        foreground: { type: "boolean", short: "f" },
        stop: { type: "boolean" },
        status: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
}
const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const units: Record<string, number> = { "": 1, ms: 1, s: 1000, m: 60000, h: 3600000 };

export function parseDuration(value: string) {
  if (value.trim().toLowerCase() === "forever") return 0;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim().toLowerCase());
  const duration = match ? Number(match[1]) * units[match[2] ?? ""]! : NaN;
  return Number.isSafeInteger(duration) ? duration : undefined;
}

export function parse(
  argv: string[],
  env: Environment = process.env,
): Invocation | { error: string } {
  const parsed = tokenize(argv);
  if ("error" in parsed) return parsed;
  const { values, positionals } = parsed;
  if (positionals.length > 1)
    return {
      error: `Expected at most one path, received ${positionals.length}`,
    };
  if (values.desktop && (values.stop || values.status || values.foreground || values["no-open"] || values.port || values.host || values["keep-alive"] || values.lan))
    return { error: "--desktop cannot be combined with browser runtime options" };
  if (values.lan && values.host)
    return { error: "--lan binds every interface and cannot be combined with --host" };
  const requested = text(values.port) ?? env.PORT;
  const port = requested === undefined ? 0 : Number(requested);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    return {
      error: `Port must be a whole number between 0 and 65535, received "${requested}"`,
    };
  const lifetime = text(values["keep-alive"]) ?? setting("KEEP_ALIVE", env);
  const keepAlive = lifetime === undefined ? 0 : parseDuration(lifetime);
  if (keepAlive === undefined)
    return {
      error: `Keep-alive must be a duration such as 75s, 15m, 1h, forever, or milliseconds, received "${lifetime}"`,
    };
  return {
    target: positionals[0] ?? setting("WORKSPACE", env) ?? ".",
    port,
    keepAlive,
    host: values.lan ? "0.0.0.0" : (text(values.host) ?? env.HOST ?? DEFAULT_HOST),
    lan: values.lan === true,
    open: values["no-open"] !== true,
    foreground: values.foreground === true,
    action: values.help
      ? "help"
      : values.version
        ? "version"
        : values.stop
          ? "stop"
          : values.status
            ? "status"
            : values.desktop ? "desktop" : "open",
  };
}

// A directory is the workspace. A file keeps the current directory as the workspace when it lives inside
// it, so `oxbit src/main.ts` from a checkout opens the checkout with that file focused.
export async function resolveTarget(
  target: string,
  cwd: string,
): Promise<Target> {
  const resolved = path.resolve(cwd, target);
  let directory: boolean;
  try {
    directory = (await fs.stat(resolved)).isDirectory();
  } catch {
    throw new Error(`No such file or directory: ${resolved}`);
  }
  if (directory) return { root: await fs.realpath(resolved) };
  const file = await fs.realpath(resolved);
  const here = await fs.realpath(cwd);
  const root = file.startsWith(here + path.sep) ? here : path.dirname(file);
  return { root, file: path.relative(root, file).split(path.sep).join("/") };
}

export function serveFailure(error: unknown, host: string, port: number | undefined) {
  const failure = error as NodeJS.ErrnoException;
  const address = `${host}:${port ?? 0}`;
  if (failure.code === "EADDRINUSE")
    return `Cannot serve on ${address}: the port is in use. Stop the process holding it or choose another with --port.`;
  if (failure.code === "EACCES" || failure.code === "EPERM")
    return `Cannot serve on ${address}: permission denied. Choose a port above 1023 or another --host.`;
  if (failure.code === "EADDRNOTAVAIL")
    return `Cannot serve on ${address}: the address is not available on this machine.`;
  return `The runtime could not start: ${failure.message ?? String(error)}`;
}

async function serve(
  invocation: Invocation,
  target: Target,
  dataDir: string,
  env: Environment,
) {
  try {
    return await serveRuntime(invocation, target, dataDir, env);
  } catch (error) {
    process.stderr.write(serveFailure(error, invocation.host, invocation.port) + "\n");
    return 1;
  }
}

async function serveRuntime(
  invocation: Invocation,
  target: Target,
  dataDir: string,
  env: Environment,
) {
  const host = invocation.host;
  const port = invocation.port;
  let stop = () => {};
  const runtime = await createRuntime({
    root: target.root,
    port,
    host,
    dataDir,
    pairingCode: setting("PAIRING_CODE", env),
    pairingAttemptsPerMinute: setting("PAIRING_ATTEMPTS_PER_MINUTE", env) === undefined ? undefined : Number(setting("PAIRING_ATTEMPTS_PER_MINUTE", env)),
    origins: setting("ORIGINS", env)?.split(",").filter(Boolean),
    webRoot: setting("WEB_ROOT", env),
    ...(invocation.keepAlive ? { idleShutdown: { afterMs: invocation.keepAlive, onIdle: () => stop() } } : {}),
  });
  let advertiser: Advertiser | undefined;
  if (invocation.lan) {
    const { id, name, version } = runtime.identity;
    advertiser = advertise({ id, name, version, port: runtime.port });
  }
  const daemon: Daemon = {
    id: runtime.identity.id,
    pid: process.pid,
    host,
    port: runtime.port,
    pairingCode: runtime.pairingCode,
    root: runtime.root,
    startedAt: Date.now(),
  };
  await writeRecord(dataDir, daemon);
  const url = launchUrl(daemon, target.file);
  process.stdout.write(
    (invocation.lan ? networkSummary(daemon) : `Oxbit runtime: http://${host}:${runtime.port}\nWorkspace: ${runtime.root}\nOwner pairing code: ${runtime.pairingCode}\nRuntime id: ${runtime.identity.id}\n`) +
      `Open: ${url}\n`,
  );
  if (invocation.open) launchBrowser(url);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void Promise.resolve(advertiser?.close())
        .then(() => runtime.close())
        .then(() => removeRecord(dataDir))
        .then(resolve, resolve);
    };
    stop = () => {
      process.stdout.write(`No client connected for ${invocation.keepAlive} ms; stopping\n`);
      shutdown();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}

export function networkSummary(daemon: Daemon, address = lanUrl(daemon.port)) {
  return `Oxbit runtime on your network: ${address ?? `http://0.0.0.0:${daemon.port} (no LAN address found)`}\nWorkspace: ${daemon.root}\nOwner pairing code: ${daemon.pairingCode}\nRuntime id: ${daemon.id}\n`;
}

async function detach(
  invocation: Invocation,
  target: Target,
  dataDir: string,
  entry: string,
) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const log = await fs.open(logFile(dataDir), "a", 0o600);
  const args = [entry, "--foreground", "--no-open", ...(invocation.lan ? ["--lan"] : ["--host", invocation.host])];
  if (invocation.port) args.push("--port", String(invocation.port));
  args.push("--keep-alive", invocation.keepAlive ? String(invocation.keepAlive) : "forever");
  args.push(target.root);
  // The daemon takes its workspace and port from the arguments, so inherited settings cannot contradict them.
  const env: Environment = { ...process.env, OXBIT_DATA_DIR: dataDir };
  delete env.PORT;
  delete env.HOST;
  delete env.OXBIT_WORKSPACE;
  delete env.OXBIT_KEEP_ALIVE;
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env,
  });
  let exit: number | undefined;
  child.on("exit", (code) => {
    exit = code ?? 1;
  });
  child.unref();
  await log.close();
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    const daemon = await liveDaemon(dataDir);
    if (daemon && daemon.pid === child.pid) return daemon;
    if (exit !== undefined) break;
    await delay(100);
  }
  const reason =
    exit === undefined ? `within ${READY_TIMEOUT / 1000}s` : `(exit ${exit})`;
  const tail = await fs
    .readFile(logFile(dataDir), "utf8")
    .then((text) => text.trimEnd().split("\n").slice(-10).join("\n"))
    .catch(() => "");
  throw new Error(
    `The runtime did not start ${reason}.${tail ? "\n" + tail : ""}`,
  );
}

async function stop(dataDir: string, root: string) {
  const daemon = await liveDaemon(dataDir);
  if (!daemon) {
    await removeRecord(dataDir);
    process.stderr.write(`No runtime is serving ${root}\n`);
    return 1;
  }
  process.kill(daemon.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT;
  while (Date.now() < deadline && running(daemon.pid)) await delay(100);
  if (running(daemon.pid)) {
    process.stderr.write(
      `The runtime for ${root} (pid ${daemon.pid}) did not exit\n`,
    );
    return 1;
  }
  await removeRecord(dataDir);
  process.stdout.write(`Stopped the runtime serving ${root}\n`);
  return 0;
}

async function status(dataDir: string, root: string) {
  const daemon = await liveDaemon(dataDir);
  if (!daemon) {
    process.stdout.write(`No runtime is serving ${root}\n`);
    return 1;
  }
  process.stdout.write(
    `Workspace: ${daemon.root}\nRuntime: http://${daemon.host}:${daemon.port}\n${daemon.id ? `Runtime id: ${daemon.id}\n` : ""}Process: ${daemon.pid}\nOpen: ${launchUrl(daemon)}\n`,
  );
  return 0;
}

export interface Context {
  env?: Environment;
  cwd?: string;
  // The detached daemon re-runs this file, which is the bundle in a build and the entry under tsx.
  entry?: string;
}

export async function run(
  argv: string[],
  context: Context = {},
): Promise<number> {
  const {
    env = process.env,
    cwd = process.cwd(),
    entry = fileURLToPath(import.meta.url),
  } = context;
  const invocation = parse(argv, env);
  if ("error" in invocation) {
    process.stderr.write(`${invocation.error}\n\n${USAGE}`);
    return 2;
  }
  if (invocation.action === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (invocation.action === "version") {
    process.stdout.write(`${runtimeVersion()}\n`);
    return 0;
  }
  let target: Target;
  try {
    target = await resolveTarget(invocation.target, cwd);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  if (invocation.action === "desktop") return launchDesktop(target.file ? path.join(target.root, target.file) : target.root);
  const dataDir = dataDirFor(target.root, env);
  if (invocation.action === "stop") return stop(dataDir, target.root);
  if (invocation.action === "status") return status(dataDir, target.root);
  if (invocation.foreground) return serve(invocation, target, dataDir, env);
  const existing = await liveDaemon(dataDir);
  if (existing && invocation.lan && !wildcardHost(existing.host)) {
    process.stderr.write(`A runtime already serves ${existing.root} on ${existing.host}. Run oxbit --stop, then oxbit --lan.\n`);
    return 1;
  }
  let daemon: Daemon;
  if (existing) daemon = existing;
  else
    try {
      daemon = await detach(invocation, target, dataDir, entry);
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 1;
    }
  const url = launchUrl(daemon, target.file);
  process.stdout.write(invocation.lan ? `${networkSummary(daemon)}Open: ${url}\n` : `${daemon.root}\n${url}\n`);
  if (invocation.open) launchBrowser(url);
  return 0;
}

export function desktopCommand(target: string, platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["/usr/bin/open", ["-b", "com.yannelli.oxbit", target]];
  if (platform === "linux") return ["oxbit-desktop", [target]];
  throw new Error("Oxbit desktop supports Apple Silicon macOS and Linux x64");
}
async function launchDesktop(target: string): Promise<number> {
  const [command, args] = desktopCommand(target);
  return new Promise(resolve => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => { process.stderr.write("Oxbit desktop is not installed. Install it from https://github.com/yannelli/oxbit/releases.\n"); resolve(1); });
    if (process.platform === "darwin") child.once("exit", code => { if (code) process.stderr.write("Install Oxbit.app before using --desktop.\n"); resolve(code ? 1 : 0); });
    else child.once("spawn", () => { child.unref(); resolve(0); });
  });
}
