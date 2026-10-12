import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { MODES, type Fetch, type PermissionMode } from "@oxbit/agent-core";
import type { FileSystem } from "@oxbit/sdk";
import { serveStdio } from "./acp-server.js";
import { FileAuthStore, FileCatalogCache } from "./auth.js";
import { AgentConfig, agentHome } from "./config.js";
import { MemoryConnection } from "./connection.js";
import { agentFactory, type AgentSetup } from "./host.js";
import { nodeFilesystem } from "./fs.js";
import { UsageError, login, logout, models, readAll, type AuthCommand } from "./login.js";
import { runPrint } from "./print.js";
import { PROVIDER_IDS, selectProvider, type ProviderChoice, type ProviderInput } from "./providers.js";
import { JsonlSessionStore } from "./sessions.js";
import { agentVersion } from "./version.js";

export const USAGE = `Usage: oxbit-agent [options] [prompt]     Terminal UI
       oxbit-agent -p <prompt> [options]   Print one reply and exit
       oxbit-agent acp                     ACP agent on stdin/stdout
       oxbit-agent models                  List the provider's models
       oxbit-agent login                   List the sign-in methods
       oxbit-agent login chatgpt           Continue with ChatGPT to use your ChatGPT plan
       oxbit-agent login --provider <id>   Save an API key read from stdin
       oxbit-agent logout [provider|chatgpt]  Remove saved keys, or sign out of ChatGPT

Options:
  -p, --print <prompt>   Run one prompt; "-" reads it from stdin
  -m, --model <id>       Model for this run
      --provider <id>    ${PROVIDER_IDS.join(", ")}
      --mode <mode>      ${MODES.map((mode) => mode.id).join(", ")}
  -c, --continue         Continue the latest session in this directory
  -r, --resume <id>      Resume a saved session
  -v, --version          Print the version
  -h, --help             Print this help

Settings, keys, sessions and skills live in ~/.oxbit/agent (OXBIT_AGENT_HOME).
`;
const OPTIONS = {
  print: { type: "string", short: "p" }, model: { type: "string", short: "m" }, provider: { type: "string" }, mode: { type: "string" },
  continue: { type: "boolean", short: "c" }, resume: { type: "string", short: "r" }, version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" },
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
}
/** What `./tui/index.js` exports. `providerLabel` is "Using ChatGPT plan" for plan requests, else the provider name. */
export interface TuiModule {
  runTui(options: { connection: MemoryConnection; cwd: string; sessionId?: string; prompt?: string; mode?: PermissionMode;
    files: FileSystem; provider: string; providerLabel?: string; version: string }): Promise<number>;
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
      case "acp": return await acp(config, await selectProvider(input), io, log);
      case "models": return await models(commandContext);
      case "login": return await login(commandContext, rest);
      case "logout": return await logout(commandContext, rest);
    }
    const provider = await selectProvider(input);
    const setup = (generateTitles: boolean, quiet = false): AgentSetup => ({ root: io.cwd, config, generateTitles, log: quiet ? undefined : log, provider });
    const sessionId = await resumeId(config, values, io.cwd);
    const mode = (values.mode ?? config.settings.mode) as PermissionMode | undefined;
    if (values.print !== undefined) {
      if (positionals.length) throw new UsageError(`Unexpected argument ${positionals[0]}`);
      const prompt = values.print === "-" ? (await readAll(io.stdin)).trim() : values.print;
      if (!prompt) throw new UsageError("The prompt is empty");
      const connection = await MemoryConnection.open(agentFactory(setup(false)));
      const abort = new AbortController();
      const interrupt = () => abort.abort();
      process.once("SIGINT", interrupt);
      try {
        return await runPrint({ connection, prompt, sessionId, mode, model: values.model, stdout: io.stdout, stderr: io.stderr, signal: abort.signal });
      } finally {
        process.off("SIGINT", interrupt);
        await connection.close();
      }
    }
    if (!io.stdout.isTTY) throw new UsageError("stdout is not a terminal. Use -p <prompt> for one reply or `oxbit-agent acp` for ACP");
    const specifier = "./tui/index.js";
    let tui: TuiModule;
    try {
      tui = await import(/* @vite-ignore */ specifier);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
      throw new Error("The terminal UI is not in this build yet. Use -p <prompt> or `oxbit-agent acp`");
    }
    const connected = setup(true, true);
    const connection = await MemoryConnection.open(agentFactory(connected));
    try {
      return await tui.runTui({ connection, cwd: io.cwd, sessionId, prompt: positionals.join(" ") || undefined, mode,
        files: nodeFilesystem(io.cwd), provider: connected.provider.id, providerLabel: connected.provider.runtime.label, version: agentVersion() });
    } finally {
      await connection.close();
    }
  } catch (error) {
    io.stderr.write(`oxbit-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
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

async function acp(config: AgentConfig, provider: ProviderChoice, io: CliIO, log: (text: string) => void) {
  await serveStdio({ input: io.stdin, output: io.stdout, factory: agentFactory({ root: io.cwd, config, provider, log }), log });
  return 0;
}
