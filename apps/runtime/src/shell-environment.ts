import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { trackChild } from "./owned-processes.js";
import { resolveTerminalShell } from "./terminal-shell.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const shellOwned = new Set(["PWD", "OLDPWD", "SHLVL", "_", "OXBIT_RESOLVING_ENVIRONMENT"]);
// Launch-time authentication, agents, and proxies take precedence over shell defaults.
const launchOwned = (key: string) =>
  /^(SSH_|GH_|GITHUB_)/.test(key) || key.toLowerCase().endsWith("_proxy");

export function parseShellEnvironment(output: string, mark: string) {
  const start = output.indexOf(mark), end = output.lastIndexOf(mark);
  if (start < 0 || end <= start) return undefined;
  const env: Record<string, string> = {};
  for (const entry of output.slice(start + mark.length, end).split("\0")) {
    const separator = entry.indexOf("="), key = entry.slice(0, separator);
    if (separator > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !shellOwned.has(key))
      env[key] = entry.slice(separator + 1);
  }
  return env;
}

/** Environment after the terminal shell's startup files, such as the PATH from nvm in ~/.bashrc. */
export function loginShellEnvironment(
  cwd: string,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  timeout = 10_000,
): Promise<NodeJS.ProcessEnv> {
  if (platform === "win32") return Promise.resolve(inherited);
  const { shell, args } = resolveTerminalShell(inherited, platform);
  const mark = randomBytes(12).toString("hex");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0, settled = false;
    // A new session has no controlling terminal, so an interactive shell cannot take the runtime's tty.
    const child = spawn(shell, [...args, "-c", `printf ${mark}; /usr/bin/env -0; printf ${mark}`], {
      cwd,
      env: { ...inherited, OXBIT_RESOLVING_ENVIRONMENT: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    trackChild(child);
    const finish = (env?: Record<string, string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (!env) {
        resolve(inherited);
        return;
      }
      const merged: NodeJS.ProcessEnv = { ...inherited, ...env };
      for (const [key, value] of Object.entries(inherited))
        if (launchOwned(key)) merged[key] = value;
      resolve(merged);
    };
    const timer = setTimeout(() => finish(), timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) finish();
      else chunks.push(chunk);
    });
    child.on("error", () => finish());
    child.on("close", (code) =>
      finish(code === 0 ? parseShellEnvironment(Buffer.concat(chunks).toString(), mark) : undefined));
  });
}
