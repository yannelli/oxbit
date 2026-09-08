import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pipeline } from "node:stream/promises";
import {
  installScript,
  parseSshTarget,
  shellQuote,
  sshArguments,
} from "./ssh-target.js";

export interface RemoteFrame {
  version: number;
  type: string;
  port?: number;
  host?: string;
  root?: string;
  openFile?: string;
  workspaceKey?: string;
  request?: string;
  message?: string;
}
export interface SshOptions {
  target: string;
  workspaceKey: string;
  token: string;
  payloadDirectory: string;
  development?: boolean;
  signal?: AbortSignal;
  sshConfig?: string;
  onProgress?: (message: string) => void;
  onFrame?: (frame: RemoteFrame) => void;
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** All sockets belong to this session. No remote PID ever reaches the native process supervisor. */
export async function connectSsh(options: SshOptions) {
  const target = parseSshTarget(options.target);
  options.signal?.throwIfAborted();
  // OpenSSH control paths have a small platform limit; use a short, private directory.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oxssh-"));
  await fs.chmod(directory, 0o700);
  const socket = path.join(directory, "s");
  const args = sshArguments(target, socket);
  const children = new Set<ChildProcessWithoutNullStreams>();
  const abort = new AbortController();
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let session: ChildProcessWithoutNullStreams | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let cleanup: Promise<void> | undefined;
  function start(extra: string[], command?: string) {
    if (stopped) throw new Error("SSH connection cancelled");
    const sshConfig = extra.includes("-O") ? "none" : options.sshConfig;
    const child = spawn(
      "ssh",
      [
        ...args,
        ...(sshConfig ? ["-F", sshConfig] : []),
        "-o",
        `ClearAllForwardings=${extra.includes("forward") ? "no" : "yes"}`,
        ...extra,
        target.destination,
        ...(command ? [command] : []),
      ],
      {
        stdio: "pipe",
        env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
      },
    );
    // Install listeners immediately: missing ssh and EPIPE must never escape as unhandled events.
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  }
  const stop = () =>
    (cleanup ??= (async () => {
      stopped = true;
      clearInterval(heartbeat);
      abort.abort();
      options.signal?.removeEventListener("abort", cancelled);
      if (session?.exitCode === null) {
        session.stdin.end('{"version":1,"type":"shutdown"}\n');
        await Promise.race([
          new Promise<void>((resolve) =>
            session!.once("close", () => resolve()),
          ),
          delay(4500),
        ]);
      }
      for (const child of children) child.kill("SIGTERM");
      await Promise.race([
        Promise.all(
          [...children].map(
            (child) =>
              new Promise<void>((resolve) =>
                child.once("close", () => resolve()),
              ),
          ),
        ),
        delay(1000),
      ]);
      for (const child of children) child.kill("SIGKILL");
      await fs.rm(directory, { recursive: true, force: true });
      resolveClosed();
    })());
  const cancelled = () => {
    void stop();
  };
  options.signal?.addEventListener("abort", cancelled, { once: true });
  const collect = (child: ChildProcessWithoutNullStreams, timeout = 30000) =>
    new Promise<string>((resolve, reject) => {
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("SSH operation timed out"));
      }, timeout);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 65536) {
          child.kill();
          reject(new Error("SSH returned too much output"));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(
          new Error(
            "OpenSSH is unavailable. Install the ssh client and retry.",
          ),
        );
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else
          reject(
            new Error(
              `SSH failed. Verify this host with ssh ${target.destination} in a terminal, then retry. ${stderr.replace(/[\x00-\x1f\x7f]/g, " ").trim()}`,
            ),
          );
      });
    });
  const execute = (command: string, extra: string[] = []) => {
    const child = start(extra, command);
    const result = collect(child);
    child.stdin.end();
    return result;
  };
  const taskForwards = new Map<string, Promise<number>>();
  const forwardTask = (frame: RemoteFrame) => {
    if (typeof frame.request !== "string" || frame.request.length > 128 || !Number.isInteger(frame.port) || frame.port! < 1 || frame.port! > 65535 || typeof frame.host !== "string" || !(net.isIP(frame.host) || frame.host === "localhost")) throw new Error("Invalid task port forwarding request");
    const key = `${frame.host}:${frame.port}`;
    let pending = taskForwards.get(key);
    if (!pending) {
      if (taskForwards.size >= 256) throw new Error("Too many task port forwards; reconnect the workspace");
      pending = (async () => {
        const host = frame.host!.includes(":") ? `[${frame.host}]` : frame.host!;
        for (let attempt = 0; attempt < 5; attempt++) {
          const port = await freePort();
          try { await execute("", ["-O", "forward", "-L", `127.0.0.1:${port}:${host}:${frame.port}`]); return port; }
          catch (error) { if (attempt === 4) throw error; }
        }
        throw new Error("SSH task port forwarding failed");
      })();
      taskForwards.set(key, pending);
      void pending.catch(() => taskForwards.delete(key));
    }
    void pending.then(port => session?.stdin.write(JSON.stringify({ version: 1, type: "taskForwarded", request: frame.request, port }) + "\n"), () => session?.stdin.write(JSON.stringify({ version: 1, type: "taskForwarded", request: frame.request, error: "Could not forward the service port over SSH" }) + "\n"));
  };
  try {
    options.onProgress?.("Connecting over SSH…");
    // The first command owns the multiplexed connection and stays alive with the runtime.
    // Probe on a separate master keeps bootstrap output out of the runtime protocol.
    const master = start(["-M", "-N", "-o", "ClearAllForwardings=yes"]);
    let masterError = "";
    master.stderr.on("data", (chunk) => {
      masterError = (masterError + chunk.toString()).slice(-4096);
    });
    master.stdout.resume();
    master.stdin.end();
    let failed = false;
    master.once("error", () => {
      failed = true;
    });
    master.once("close", () => {
      failed = true;
      if (session) void stop();
    });
    const deadline = Date.now() + 20000;
    while (
      !(await fs.stat(socket).catch(() => undefined)) &&
      !failed &&
      Date.now() < deadline
    ) {
      abort.signal.throwIfAborted();
      await delay(50);
    }
    if (failed || !(await fs.stat(socket).catch(() => undefined)))
      throw new Error(
        `SSH connection failed. Run ssh ${target.destination} in a terminal to verify the host key and key authentication, then retry. ${masterError.replace(/[\x00-\x1f\x7f]/g, " ").trim()}`,
      );
    const platform = await execute("uname -s; uname -m");
    const lines = platform.split(/\r?\n/);
    const pair = lines.slice(-2).join("/");
    const name = (
      { "Linux/x86_64": "linux-x64", "Darwin/arm64": "darwin-arm64" } as Record<
        string,
        string
      >
    )[pair];
    if (!name)
      throw new Error(
        "Remote SSH supports Linux x64 (glibc) and macOS Apple Silicon.",
      );
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(options.payloadDirectory, "manifest.json"),
        "utf8",
      ),
    );
    const digest: string = manifest.platforms?.[name]?.sha256;
    if (!/^[a-f0-9]{64}$/.test(digest ?? ""))
      throw new Error(
        "Remote runtime package is missing. Reinstall Oxbit to restore its remote runtime packages.",
      );
    const archive = path.join(options.payloadDirectory, `${name}.tar.gz`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== digest)
      throw new Error(
        "Local remote runtime checksum mismatch. Rebuild or reinstall Oxbit.",
      );
    const remote = `"$HOME/.oxbit/remote/runtimes/${digest}"`;
    const cached = await execute(
      `if [ -f ${remote}/.complete ]; then printf yes; fi`,
    );
    if (cached !== "yes") {
      options.onProgress?.("Installing the remote runtime…");
      const child = start([], "sh -c " + shellQuote(installScript(digest)));
      await Promise.all([
        collect(child, 180000),
        pipeline(createReadStream(archive), child.stdin, {
          signal: abort.signal,
        }),
      ]);
    }
    options.onProgress?.("Starting the remote workspace…");
    session = start(
      [],
      "sh -c " +
        shellQuote(
          `cd ${remote} || exit 1; unset NODE_OPTIONS NODE_PATH OXBIT_LSP_COMMAND; exec ${remote}/bin/node ${remote}/desktop.js`,
        ),
    );
    session.stderr.resume();
    const localPort = await freePort();
    let buffer = "";
    const ready = new Promise<RemoteFrame>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Remote runtime startup timed out. Check the remote folder and operating system compatibility.",
            ),
          ),
        25000,
      );
      const failed = () => {
        clearTimeout(timer);
        reject(
          new Error(
            "Remote runtime stopped. Check the folder path, available disk space, and platform compatibility.",
          ),
        );
      };
      session!.once("error", failed);
      session!.once("close", failed);
      session!.stdout.setEncoding("utf8");
      session!.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 65536) {
          reject(new Error("Invalid remote runtime frame"));
          void stop();
          return;
        }
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const frame = JSON.parse(line) as RemoteFrame;
            if (frame.version !== 1) throw new Error("Invalid remote protocol");
            if (frame.type === "ready") {
              clearTimeout(timer);
              resolve(frame);
            } else if (frame.type === "rotated") options.onFrame?.(frame);
            else if (frame.type === "taskForward") forwardTask(frame);
            else if (frame.type === "error") {
              clearTimeout(timer);
              reject(new Error(frame.message ?? "Remote startup failed"));
            }
            // Remote process IDs are meaningful only on the remote machine.
          } catch {
            clearTimeout(timer);
            reject(new Error("Invalid remote runtime response"));
            void stop();
          }
        }
      });
    });
    session.stdin.write(
      JSON.stringify({
        version: 1,
        type: "launch",
        remoteRuntime: true,
        root: target.path,
        workspaceKey: options.workspaceKey,
        token: options.token,
        development: options.development,
      }) + "\n",
    );
    heartbeat = setInterval(
      () => session?.stdin.write('{"version":1,"type":"heartbeat"}\n'),
      10000,
    );
    const frame = await ready;
    if (
      frame.workspaceKey !== options.workspaceKey ||
      !Number.isInteger(frame.port) ||
      frame.port! < 1 ||
      frame.port! > 65535 ||
      typeof frame.root !== "string" ||
      !frame.root.startsWith("/")
    )
      throw new Error("Remote workspace identity did not match the connection");
    await execute("", [
      "-O",
      "forward",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${frame.port}`,
    ]);
    const health = await fetch(`http://127.0.0.1:${localPort}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!health.ok || (await health.json()).protocol !== 1)
      throw new Error("SSH tunnel health check failed");
    session.once("close", () => {
      void stop();
    });
    if (stopped || failed || session.exitCode !== null)
      throw new Error("SSH connection closed during startup");
    options.onProgress?.("Connected over SSH");
    return {
      port: localPort,
      root: frame.root,
      openFile: frame.openFile,
      closed,
      close: stop,
      send: (frame: object) => {
        if (stopped) throw new Error("SSH connection is closed");
        session!.stdin.write(JSON.stringify(frame) + "\n");
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
