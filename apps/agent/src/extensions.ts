import { spawn } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Compaction, Instructions, Skills, controlExtensions, createHookRunner, hookSourcePaths,
  type AgentExtensions, type HookExec, type HookSource, type HostFiles, type Params,
} from "@oxbit/agent-core";
import { stringList, type AgentConfig } from "./config.js";

/** settings.json keys read by the core extensions on each use. */
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
  /** Percent of the context window, 50 to 95, where auto-compaction starts. Unset keeps the reserve rule. */
  autoCompactAt?: number;
  /** Skill names left out of the catalog, the skill tool and the slash commands. */
  disabledSkills?: string[];
  /** Hook IDs (`dialect|path|event|matcher|command`) that do not run. */
  disabledHooks?: string[];
  /** Absolute paths of instruction files left out of the system prompt. */
  disabledInstructions?: string[];
}
/** Agent commands backed by the settings panels; skills with these names get no slash command. */
export const SETTINGS_COMMANDS = ["config", "skills", "hooks", "mcp", "instructions", "providers"] as const;
const settingsOf = (config: AgentConfig) => config.settings as ExtensionSettings;
const compactAt = (value: unknown) => typeof value === "number" && value >= 50 && value <= 95 ? value : undefined;

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

/** Reads the hook files that settings turn on, keeping each parsed file until its mtime changes. */
export function hookSources(config: AgentConfig, home: string, log?: (text: string) => void) {
  const cache = new Map<string, { mtime: number; config: unknown }>();
  return async (cwd: string): Promise<HookSource[]> => {
    const settings = settingsOf(config);
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

/** Instruction files from the global AGENTS.md, ~/.claude/CLAUDE.md when turned on, and the project; settings apply on each use. */
export function instructionsFor(config: AgentConfig, home: string) {
  return new Instructions({
    files: nodeFiles, global: config.paths.instructions,
    get claude() {
      return settingsOf(config).claudeInstructions ? join(home, ".claude", "CLAUDE.md") : undefined;
    },
    get append() {
      const append = settingsOf(config).appendSystemPrompt;
      return typeof append === "string" ? append : undefined;
    },
    skip: (path) => stringList(settingsOf(config).disabledInstructions).includes(path),
  });
}
/** ~/.oxbit/agent/skills, ~/.agents/skills, ~/.claude/skills, without `disabledSkills` in prompts and commands. */
export function skillsFor(config: AgentConfig, home: string) {
  return new Skills({ files: nodeFiles, roots: [config.paths.skills, join(home, ".agents", "skills"), join(home, ".claude", "skills")],
    hidden: (name) => stringList(settingsOf(config).disabledSkills).includes(name) });
}

/** Instructions, skills, compaction, hooks, /goal and /loop for the Node host. Each reads config.settings when it runs. */
export function coreExtensions(config: AgentConfig, update: (sessionId: string, update: Params) => void,
  options: { home?: string; log?: (text: string) => void } = {}): AgentExtensions {
  const { home = homedir(), log } = options;
  const instructions = instructionsFor(config, home);
  const skills = skillsFor(config, home);
  const reserved = new Set<string>(SETTINGS_COMMANDS);
  const compaction = new Compaction({
    get auto() {
      return settingsOf(config).autoCompact !== false;
    },
    get percent() {
      return compactAt(settingsOf(config).autoCompactAt);
    },
  });
  const control = controlExtensions({ update });
  return {
    context: [instructions, ...control.context, skills],
    tools: [...control.tools, skills],
    commands: [compaction, ...control.commands, { commands: async (session) => (await skills.discover(session.cwd),
      skills.commands(session).filter((command) => !reserved.has(command.name))) }],
    continuations: control.continuations,
    compactor: compaction,
    hooks: createHookRunner({ sources: hookSources(config, home, log), exec: nodeHookExec, onWarning: log,
      skip: (hook) => stringList(settingsOf(config).disabledHooks).includes(hook.id) }),
  };
}
