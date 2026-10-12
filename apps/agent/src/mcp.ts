import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { McpTools, type Spawn } from "@oxbit/agent-core";
import { readJson, stringList, type AgentConfig, type AgentSettings } from "./config.js";
import { agentVersion } from "./version.js";

/** Starts a stdio MCP server with PATH lookup. kill() sends SIGTERM, then SIGKILL after `killAfterMs`. */
export const nodeSpawn = (log?: (text: string) => void, killAfterMs = 2000): Spawn => ({ command, args, env, cwd, stderr }) => {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
  const name = basename(command);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  // Created now: an iterator made after lines.close() never ends.
  const iterator = lines[Symbol.asyncIterator]();
  const exited = new Promise((settle) => {
    child.once("exit", settle);
    child.once("error", (error) => {
      stderr(`${error.message}\n`);
      lines.close();
      settle(error);
    });
  });
  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr(text);
    for (const line of text.split("\n")) if (line.trim()) log?.(`MCP ${name}: ${line}`);
  });
  return {
    write: (text) => void child.stdin.write(text),
    stdout: { [Symbol.asyncIterator]: () => iterator },
    end: () => child.stdin.end(),
    kill: () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, killAfterMs).unref();
    },
    exited,
  };
};

/** A UTF-8 file, or undefined when it does not exist. */
export async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** settings.json `trustProjectMcp: true`, or a `trustedProjects` entry that is `cwd` or one of its parents. Reads the file on each call. */
export async function projectTrusted(settingsPath: string, cwd: string) {
  const settings = await readJson<AgentSettings>(settingsPath, {}).catch(() => ({}) as AgentSettings);
  if (settings?.trustProjectMcp === true) return true;
  const roots = Array.isArray(settings?.trustedProjects) ? settings.trustedProjects.filter((path) => typeof path === "string" && isAbsolute(path)) : [];
  if (!roots.length) return false;
  const forms = async (path: string) => [...new Set([resolve(path), await realpath(path).catch(() => resolve(path))])];
  const dirs = await forms(cwd);
  for (const root of (await Promise.all(roots.map(forms))).flat()) {
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (dirs.some((dir) => dir === root || dir.startsWith(prefix))) return true;
  }
  return false;
}

/** MCP servers from ~/.oxbit/agent/mcp.json, trusted `.mcp.json` files and ACP session/new, without `disabledMcpServers`. */
export function nodeMcp(config: AgentConfig, log?: (text: string) => void) {
  return new McpTools({
    fetch: (url, init) => fetch(url, init),
    spawn: nodeSpawn(log),
    read: readOptional,
    globalConfig: config.paths.mcp,
    env: process.env,
    trustProject: (cwd) => projectTrusted(config.paths.settings, cwd),
    trustHint: `Add the project path to "trustedProjects" in ${config.paths.settings} to run them.`,
    skip: (server) => stringList(config.settings.disabledMcpServers).includes(server.name),
    clientInfo: { name: "oxbit-agent", version: agentVersion() },
  });
}
