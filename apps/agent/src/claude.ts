import { spawn } from "node:child_process";
import type { PermissionMode } from "@oxbit/agent-core";
import { acpPreset } from "@oxbit/sdk";
import { ProcessConnection, type AgentCommand } from "./connection.js";

/** Claude Agent runs the unmodified Claude Code under the user's own Claude sign-in; Oxbit never reads Claude credentials. */
export const CLAUDE_PLAN = { id: "claude", name: "Claude plan", inUse: "Using Claude plan" } as const;
export const CLAUDE_SIGN_IN = "Sign in with your Claude plan first: oxbit-agent login claude";
const INSTALL = "Install Claude Code first: https://code.claude.com/docs/en/setup";
/** Oxbit permission modes as Claude Agent session modes. */
export const CLAUDE_MODES: Record<PermissionMode, string> = { ask: "default", "accept-edits": "acceptEdits", "full-auto": "bypassPermissions" };

/** Claude Agent's launch command. API key variables are dropped so Claude Code bills the signed-in plan. */
export function claudeAgent(env: NodeJS.ProcessEnv): AgentCommand {
  const preset = acpPreset("claude")!;
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  return { command: preset.command, args: [...preset.args], env: rest };
}

/** Starts Claude Agent; its auth_required reply becomes the sign-in command. */
export const openClaude = (agent: AgentCommand, cwd: string) => ProcessConnection.open(agent, cwd, {
  rewrite: (error) => error.code === -32000 && /auth/i.test(error.message) ? Object.assign(new Error(CLAUDE_SIGN_IN), { code: error.code }) : error,
});

export interface ClaudeStatus {
  installed: boolean;
  loggedIn: boolean;
  /** The subscription type when Claude Code is signed in with a Claude account, e.g. "max". */
  plan?: string;
}

const run = (args: string[], env: NodeJS.ProcessEnv, stdio: "pipe" | "inherit") => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
  const child = spawn("claude", args, { env, stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "ignore"] });
  let stdout = "";
  child.stdout?.on("data", (chunk) => void (stdout += chunk));
  child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? Object.assign(new Error(INSTALL), { missing: true }) : error));
  child.once("close", (code) => resolve({ code, stdout }));
});

/** `claude auth status --json` from the Claude Code on PATH. */
export async function claudeStatus(env: NodeJS.ProcessEnv): Promise<ClaudeStatus> {
  try {
    const { stdout } = await run(["auth", "status", "--json"], claudeAgent(env).env!, "pipe");
    const status = JSON.parse(stdout);
    return { installed: true, loggedIn: status?.loggedIn === true,
      ...status?.authMethod === "claude.ai" && typeof status.subscriptionType === "string" ? { plan: status.subscriptionType } : {} };
  } catch (error) {
    return { installed: !(error as { missing?: boolean }).missing, loggedIn: false };
  }
}

export const planText = (status: ClaudeStatus) => !status.installed ? "Claude Code not installed" : !status.loggedIn ? "not signed in"
  : status.plan ? `signed in with Claude ${status.plan[0].toUpperCase()}${status.plan.slice(1)}` : "signed in";

/** Runs `claude auth login` or `claude auth logout` on the terminal and resolves its exit code. */
export async function claudeAuth(command: "login" | "logout", env: NodeJS.ProcessEnv) {
  return (await run(["auth", command], claudeAgent(env).env!, "inherit")).code ?? 1;
}
