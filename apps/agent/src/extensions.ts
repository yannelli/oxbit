import { spawn } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Compaction, Instructions, Skills, controlExtensions, createHookRunner, hookSourcePaths,
  type AgentExtensions, type HookExec, type HookSource, type HostFiles, type Params,
} from "@oxbit/agent-core";
import type { AgentConfig } from "./config.js";

/** settings.json keys read by the core extensions. */
export interface ExtensionSettings {
  /** Text added after the instruction files. */
  appendSystemPrompt?: string;
  /** Loads ~/.claude/CLAUDE.md after the global AGENTS.md. */
  claudeInstructions?: boolean;
  /** Runs hooks from ~/.claude/settings.json, .claude/settings.json and .claude/settings.local.json. */
  claudeHooks?: boolean;
  /** Runs hooks from ~/.codex/hooks.json and .codex/hooks.json. */
  codexHooks?: boolean;
  /** false leaves compaction to /compact. */
  autoCompact?: boolean;
}

export const nodeFiles: HostFiles = {
  async list(path) {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const listed = await Promise.all(entries.map(async (entry) => {
      const kind = entry.isSymbolicLink() ? await stat(join(path, entry.name)).then((info) => info.isDirectory() ? "directory" : "file", () => undefined)
        : entry.isDirectory() ? "directory" : "file";
      return kind ? { name: entry.name, kind } as const : undefined;
    }));
    return listed.filter((entry) => !!entry);
  },
  read: (path) => readFile(path, "utf8"),
  exists: (path) => access(path).then(() => true, () => false),
};

/** Runs a hook command with /bin/sh -c; an aborted or timed out hook resolves with code null. */
export const nodeHookExec: HookExec = (command, { stdin, cwd, env, timeoutMs, signal }) => new Promise((resolve) => {
  const child = spawn("/bin/sh", ["-c", command], { cwd, env: { ...process.env, ...env }, stdio: "pipe", detached: true });
  let stdout = "", stderr = "", killed = false;
  const kill = () => {
    killed = true;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(kill, timeoutMs);
  signal.addEventListener("abort", kill, { once: true });
  child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
  const finish = (code: number | null) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
    resolve({ code: killed ? null : code, stdout, stderr });
  };
  child.on("error", (error) => {
    stderr += error.message;
    finish(127);
  });
  child.on("close", finish);
});

/** Reads hook files, keeping each parsed file until its mtime changes. */
function hookSources(config: AgentConfig, settings: ExtensionSettings, home: string, log?: (text: string) => void) {
  const cache = new Map<string, { mtime: number; config: unknown }>();
  return async (cwd: string): Promise<HookSource[]> => {
    const paths = hookSourcePaths(home, cwd, { claude: settings.claudeHooks === true, codex: settings.codexHooks === true });
    paths[0] = { ...paths[0], path: config.paths.settings };
    const sources = await Promise.all(paths.map(async ({ dialect, path }) => {
      const mtime = await stat(path).then((info) => info.mtimeMs, () => undefined);
      if (mtime === undefined) return undefined;
      let entry = cache.get(path);
      if (entry?.mtime !== mtime) {
        try {
          entry = { mtime, config: JSON.parse(await readFile(path, "utf8")) };
        } catch (error) {
          log?.(`Hooks in ${path} are off: ${error instanceof Error ? error.message : String(error)}`);
          entry = { mtime, config: {} };
        }
        cache.set(path, entry);
      }
      return { dialect, path, config: entry.config };
    }));
    return sources.filter((source) => !!source);
  };
}

/** Instructions, skills, compaction, hooks, /goal and /loop for the Node host. */
export function coreExtensions(config: AgentConfig, update: (sessionId: string, update: Params) => void,
  options: { home?: string; log?: (text: string) => void } = {}): AgentExtensions {
  const settings = config.settings as ExtensionSettings;
  const { home = homedir(), log } = options;
  const instructions = new Instructions({
    files: nodeFiles, global: config.paths.instructions,
    claude: settings.claudeInstructions ? join(home, ".claude", "CLAUDE.md") : undefined,
    append: typeof settings.appendSystemPrompt === "string" ? settings.appendSystemPrompt : undefined,
  });
  const skills = new Skills({ files: nodeFiles, roots: [config.paths.skills, join(home, ".agents", "skills"), join(home, ".claude", "skills")] });
  const compaction = new Compaction({ auto: settings.autoCompact !== false });
  const control = controlExtensions({ update });
  return {
    context: [instructions, ...control.context, skills],
    tools: [...control.tools, skills],
    commands: [compaction, ...control.commands, { commands: async (session) => (await skills.discover(session.cwd), skills.commands(session)) }],
    continuations: control.continuations,
    compactor: compaction,
    hooks: createHookRunner({ sources: hookSources(config, settings, home, log), exec: nodeHookExec, onWarning: log }),
  };
}
