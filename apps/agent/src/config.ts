import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionMode } from "@oxbit/agent-core";

export interface ProviderSettings {
  baseUrl?: string;
  model?: string;
  /** "api-key", "chatgpt" or "none". */
  method?: string;
}
/** ~/.oxbit/agent/settings.json. Other keys (hooks, instructions) belong to extensions. */
export interface AgentSettings {
  provider?: string;
  model?: string;
  mode?: PermissionMode;
  providers?: Record<string, ProviderSettings>;
  /** Absolute paths whose `.mcp.json` servers may run, with their subdirectories. */
  trustedProjects?: string[];
  /** Runs `.mcp.json` servers in every project. */
  trustProjectMcp?: boolean;
  [key: string]: unknown;
}

/** OXBIT_AGENT_HOME, else ~/.oxbit/agent. */
export const agentHome = (env: NodeJS.ProcessEnv = process.env) => env.OXBIT_AGENT_HOME || join(homedir(), ".oxbit", "agent");

export function agentPaths(home: string) {
  return {
    home,
    settings: join(home, "settings.json"),
    auth: join(home, "auth.json"),
    mcp: join(home, "mcp.json"),
    cache: join(home, "cache"),
    instructions: join(home, "AGENTS.md"),
    skills: join(home, "skills"),
    sessions: join(home, "sessions"),
    history: join(home, "history.jsonl"),
    snapshots: join(home, "snapshots"),
  };
}
export type AgentPaths = ReturnType<typeof agentPaths>;

/** Directory name for per-cwd data: the first 16 hex digits of sha256(cwd). */
export const cwdHash = (cwd: string) => createHash("sha256").update(cwd).digest("hex").slice(0, 16);

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Writes through a temporary file and rename; `mode` applies to the final file. */
export async function writeFileAtomic(file: string, text: string, mode = 0o644) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, text, { mode });
  await chmod(temp, mode);
  await rename(temp, file);
}
export const writeJson = (file: string, value: unknown, mode?: number) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);

/** settings.json under the agent home. auth.json belongs to FileAuthStore. */
export class AgentConfig {
  readonly paths: AgentPaths;
  private constructor(home: string, public settings: AgentSettings) {
    this.paths = agentPaths(home);
  }
  static async load(home = agentHome()) {
    const settings = await readJson<AgentSettings>(agentPaths(home).settings, {});
    return new AgentConfig(home, settings && typeof settings === "object" ? settings : {});
  }
  /** Creates the home and skills directories. */
  async ensure() {
    await mkdir(this.paths.skills, { recursive: true, mode: 0o700 });
  }
  /** Merges `patch` into the file on disk, so keys written by other processes survive. */
  async saveSettings(patch: Partial<AgentSettings>) {
    const current = await readJson<AgentSettings>(this.paths.settings, {});
    this.settings = { ...current, ...patch };
    await writeJson(this.paths.settings, this.settings);
  }
}
