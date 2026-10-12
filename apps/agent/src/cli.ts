import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { MODES, type Fetch, type PermissionMode } from "@oxbit/agent-core";
import { serveStdio } from "./acp-server.js";
import { FileAuthStore, FileCatalogCache } from "./auth.js";
import { CLAUDE_MODES, CLAUDE_PLAN, claudeAgent, openClaude } from "./claude.js";
import { AgentConfig, agentHome } from "./config.js";
import { MemoryConnection, type AcpClient, type AgentCommand } from "./connection.js";
import { agentFactory, type AgentSetup } from "./host.js";
import { UsageError, login, logout, models, readAll, type AuthCommand } from "./login.js";
import { runPrint } from "./print.js";
import { PROVIDER_IDS, activeProvider, isClaude, type ActiveProvider, type ProviderInput } from "./providers.js";
import { JsonlSessionStore } from "./sessions.js";
import { createSettingsManager, type SettingsDeps } from "./settings/index.js";
import { agentVersion } from "./version.js";

export const USAGE = `Usage: oxbit-agent [options] [prompt]     Terminal UI
       oxbit-agent -p <prompt> [options]   Print one reply and exit
       oxbit-agent acp                     ACP agent on stdin/stdout
       oxbit-agent models                  List the provider's models
       oxbit-agent login                   List the sign-in methods
       oxbit-agent login chatgpt           Continue with ChatGPT to use your ChatGPT plan
       oxbit-agent login claude            Sign in to Claude Code to use your Claude plan
       oxbit-agent login --provider <id>   Save an API key read from stdin
       oxbit-agent logout [provider|chatgpt|claude]  Remove saved keys, or sign out of ChatGPT or Claude Code

Options:
  -p, --print <prompt>   Run one prompt; "-" reads it from stdin
  -m, --model <id>       Model for this run
      --provider <id>    ${PROVIDER_IDS.join(", ")}
      --mode <mode>      ${MODES.map((mode) => mode.id).join(", ")}
  -c, --continue         Continue the latest session in this directory
  -r, --resume <id>      Resume a saved session
      --inline           Render the terminal UI inline instead of fullscreen
  -v, --version          Print the version
  -h, --help             Print this help

Settings, keys, sessions and skills live in ~/.oxbit/agent (OXBIT_AGENT_HOME).
`;
const OPTIONS = {
  print: { type: "string", short: "p" }, model: { type: "string", short: "m" }, provider: { type: "string" }, mode: { type: "string" },
  continue: { type: "boolean", short: "c" }, resume: { type: "string", short: "r" }, inline: { type: "boolean" }, version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" },
} as const;
type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

export interface CliIO {
  stdin: Readable & { isTTY?: boolean; setRawMode?(raw: boolean): unknown };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Replaces the global fetch for model, sign-in and catalog requests, for tests. */
  fetch?: Fetch;
  /** Replaces the system browser for Sign in with ChatGPT; resolves false when no browser opened. */
  open?(url: string): Promise<boolean>;
  /** Replaces the Claude Agent command, for tests. */
  claudeAgent?: AgentCommand;
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (error) {
    io.stderr.write(`oxbit-agent: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) return void io.stdout.write(USAGE), 0;
  if (values.version) return void io.stdout.write(`oxbit-agent ${agentVersion()}\n`), 0;
  const log = (text: string) => void io.stderr.write(`oxbit-agent: ${text}\n`);
  try {
    if (values.mode && !MODES.some((mode) => mode.id === values.mode)) throw new UsageError(`Unknown mode ${values.mode}`);
    const config = await AgentConfig.load(agentHome(io.env));
    await config.ensure();
    const auth = new FileAuthStore(config.paths.auth);
    const input: ProviderInput = { provider: values.provider, model: values.model, settings: config.settings, env: io.env, auth,
      fetch: io.fetch, cache: new FileCatalogCache(config.paths.cache) };
    const commandContext: AuthCommand = { config, auth, io, input };
    const [command, ...rest] = positionals;
    switch (command) {
      case "models": return await models(commandContext);
      case "login": return await login(commandContext, rest);
      case "logout": return await logout(commandContext, rest);
    }
    let provider: ActiveProvider = await activeProvider(input);
    const deps: SettingsDeps = { config, auth, env: io.env, fetch: io.fetch, open: io.open, provider: () => provider };
    const settings = createSettingsManager(deps);
    const claude = () => io.claudeAgent ?? claudeAgent(io.env);
    const startClaude = () => {
      io.stderr.write("Starting Claude Agent with npx; the first run downloads it.\n");
      return openClaude(claude(), io.cwd);
    };
    const open = (choice: ActiveProvider, generateTitles: boolean, quiet = false): Promise<AcpClient> => isClaude(choice) ? startClaude()
      : MemoryConnection.open(agentFactory({ root: io.cwd, config, generateTitles, log: quiet ? undefined : log, provider: choice, settings } satisfies AgentSetup));
    const mode = (values.mode ?? config.settings.mode) as PermissionMode | undefined;
    const session = (connection: AcpClient) => isClaude(provider) ? claudeResume(connection, values, io.cwd) : resumeId(config, values, io.cwd);
    if (command === "acp") {
      if (isClaude(provider)) return await relay(claude(), io);
      // Node exits on an unhandled rejection; the client would lose the session over one failed background task.
      const rejected = (error: unknown) => log(`Unhandled rejection: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.on("unhandledRejection", rejected);
      try {
        await serveStdio({ input: io.stdin, output: io.stdout, factory: agentFactory({ root: io.cwd, config, generateTitles: true, log, provider, settings }), log });
      } finally {
        process.off("unhandledRejection", rejected);
      }
      return 0;
    }
    if (values.print !== undefined) {
      if (positionals.length) throw new UsageError(`Unexpected argument ${positionals[0]}`);
      const prompt = values.print === "-" ? (await readAll(io.stdin)).trim() : values.print;
      if (!prompt) throw new UsageError("The prompt is empty");
      const connection = await open(provider, false);
      const abort = new AbortController();
      const interrupt = () => abort.abort();
      process.once("SIGINT", interrupt);
      try {
        const sessionId = await session(connection);
        return await runPrint({ connection, prompt, sessionId, cwd: io.cwd, mode: mode && isClaude(provider) ? CLAUDE_MODES[mode] : mode,
          model: isClaude(provider) ? provider.model : values.model, stdout: io.stdout, stderr: io.stderr, signal: abort.signal });
      } finally {
        process.off("SIGINT", interrupt);
        await connection.close();
      }
    }
    if (!io.stdout.isTTY) throw new UsageError("stdout is not a terminal. Use -p <prompt> for one reply or `oxbit-agent acp` for ACP");
    // Loaded on demand so ACP and print mode run without ink and react installed.
    const [tui, memory] = await Promise.all([import("./tui/index.js"), import("./tui/memory.js")]);
    const label = () => isClaude(provider) ? { provider: CLAUDE_PLAN.inUse }
      : { provider: provider.runtime.label, usingChatGPTPlan: provider.runtime.method === "chatgpt" };
    const claudeOptions = () => isClaude(provider) ? { modes: CLAUDE_MODES, model: provider.model } : {};
    const panels = createSettingsManager({ ...deps, rebuild: async (id) => {
      await config.reload();
      const next = await activeProvider({ ...input, settings: config.settings, provider: id, model: id === provider.id ? provider.model : undefined });
      const connection = await open(next, true, true);
      provider = next;
      await adapter.replace(connection, label(), claudeOptions());
    } });
    const first = await open(provider, true, true);
    const adapter = memory.memoryTuiConnection(first, { ...label(), ...claudeOptions(), mode, settings: panels });
    try {
      const sessionId = await session(first);
      const { sessionId: last } = await tui.run(adapter, { cwd: io.cwd, sessionId, prompt: positionals.join(" ") || undefined, version: agentVersion(),
        history: memory.fileHistory(config.paths.history), fullscreen: !values.inline });
      if (last) io.stderr.write(`Resume this session with: oxbit-agent -r ${last}\n`);
      return 0;
    } finally {
      await adapter.connection.close();
    }
  } catch (error) {
    io.stderr.write(`oxbit-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

/** Claude Agent's latest session in `cwd` for --continue; --resume IDs pass through to session/load. */
async function claudeResume(connection: AcpClient, values: Values, cwd: string) {
  if (values.continue && values.resume) throw new UsageError("Use --continue or --resume, not both");
  if (!values.continue) return values.resume;
  const [latest] = (await connection.listSessions(cwd)).sessions.filter((item) => item.cwd === cwd)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  if (!latest) throw new Error(`No saved session for ${cwd}`);
  return latest.sessionId;
}

/** Runs `agent` on this process's ACP stdin and stdout. */
function relay(agent: AgentCommand, io: CliIO) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(agent.command, agent.args, { cwd: io.cwd, env: agent.env, stdio: ["pipe", "pipe", "pipe"] });
    child.once("error", (error) => reject(new Error(`Could not start ${agent.command}: ${error.message}`)));
    child.stdin.on("error", () => {});
    io.stdin.pipe(child.stdin);
    child.stdout.on("data", (chunk) => io.stdout.write(chunk));
    child.stderr.on("data", (chunk) => io.stderr.write(chunk));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function resumeId(config: AgentConfig, values: Values, cwd: string) {
  if (values.continue && values.resume) throw new UsageError("Use --continue or --resume, not both");
  const store = new JsonlSessionStore(config.paths.sessions);
  if (values.continue) {
    const latest = await store.latest(cwd);
    if (!latest) throw new Error(`No saved session for ${cwd}`);
    return latest.id;
  }
  if (values.resume && !await store.load(values.resume)) throw new Error(`No saved session ${values.resume}`);
  return values.resume;
}

