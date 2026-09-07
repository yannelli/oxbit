import * as fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRuntime } from "./runtime.js";
import { setting } from "./branding.js";
import {
  available,
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

export const DEFAULT_PORT = 9277;
export const DEFAULT_HOST = "127.0.0.1";
const READY_TIMEOUT = 60000;
const STOP_TIMEOUT = 10000;

export const USAGE = `oxbit [options] [path]

Open a workspace in Oxbit. Starts a runtime for the workspace unless one is
already serving it, then opens the paired editor in the default browser.

  path                 File or directory to open (default: $OXBIT_WORKSPACE or .)

Options
  -p, --port <number>  Port to serve on (default: $PORT or ${DEFAULT_PORT})
      --host <address> Address to bind (default: $HOST or ${DEFAULT_HOST})
      --desktop        Open in the installed Oxbit desktop application
      --no-open        Leave the browser closed
  -f, --foreground     Serve in this terminal and stay attached
      --stop           Stop the runtime serving the workspace
      --status         Report the runtime serving the workspace
  -h, --help           Show this message
  -v, --version        Show the runtime version
`;

export interface Invocation {
  target: string;
  port?: number;
  host: string;
  open: boolean;
  foreground: boolean;
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
        "no-open": { type: "boolean" },
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
  if (values.desktop && (values.stop || values.status || values.foreground || values["no-open"] || values.port || values.host))
    return { error: "--desktop cannot be combined with browser runtime options" };
  const requested = text(values.port) ?? env.PORT;
  const port = requested === undefined ? undefined : Number(requested);
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 0 || port > 65535)
  )
    return {
      error: `Port must be a whole number between 0 and 65535, received "${requested}"`,
    };
  return {
    target: positionals[0] ?? setting("WORKSPACE", env) ?? ".",
    port,
    host: text(values.host) ?? env.HOST ?? DEFAULT_HOST,
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

async function serve(
  invocation: Invocation,
  target: Target,
  dataDir: string,
  env: Environment,
) {
  const host = invocation.host;
  // A defaulted port may move aside for whatever holds it; an explicit one fails loudly instead.
  const port =
    invocation.port ??
    ((await available(host, DEFAULT_PORT)) ? DEFAULT_PORT : 0);
  const runtime = await createRuntime({
    root: target.root,
    port,
    host,
    dataDir,
    pairingCode: setting("PAIRING_CODE", env),
    origins: setting("ORIGINS", env)?.split(",").filter(Boolean),
    webRoot: setting("WEB_ROOT", env),
  });
  const daemon: Daemon = {
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
    `Oxbit runtime: http://${host}:${runtime.port}\nWorkspace: ${runtime.root}\nOwner pairing code: ${runtime.pairingCode}\nOpen: ${url}\n`,
  );
  if (invocation.open) launchBrowser(url);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void runtime
        .close()
        .then(() => removeRecord(dataDir))
        .then(resolve, resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}

async function detach(
  invocation: Invocation,
  target: Target,
  dataDir: string,
  entry: string,
) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const log = await fs.open(logFile(dataDir), "a", 0o600);
  const args = [entry, "--foreground", "--no-open", "--host", invocation.host];
  if (invocation.port !== undefined)
    args.push("--port", String(invocation.port));
  args.push(target.root);
  // The daemon takes its workspace and port from the arguments, so inherited settings cannot contradict them.
  const env: Environment = { ...process.env, OXBIT_DATA_DIR: dataDir };
  delete env.PORT;
  delete env.HOST;
  delete env.OXBIT_WORKSPACE;
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
    `Workspace: ${daemon.root}\nRuntime: http://${daemon.host}:${daemon.port}\nProcess: ${daemon.pid}\nOpen: ${launchUrl(daemon)}\n`,
  );
  return 0;
}

async function version() {
  try {
    const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(await fs.readFile(manifest, "utf8")).version;
  } catch {
    return "unknown";
  }
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
    process.stdout.write(`${await version()}\n`);
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
  process.stdout.write(`${daemon.root}\n${url}\n`);
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
