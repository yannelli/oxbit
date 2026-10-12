import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { MODES, listModels, type PermissionMode } from "@oxbit/agent-core";
import type { FileSystem } from "@oxbit/sdk";
import { serveStdio } from "./acp-server.js";
import { AgentConfig, agentHome } from "./config.js";
import { MemoryConnection } from "./connection.js";
import { agentFactory, type AgentSetup } from "./host.js";
import { nodeFilesystem } from "./fs.js";
import { runPrint } from "./print.js";
import { PROVIDERS, missingKey, needsKey, nodeModels, selectProvider, type ProviderId } from "./providers.js";
import { JsonlSessionStore } from "./sessions.js";
import { agentVersion } from "./version.js";

export const USAGE = `Usage: oxbit-agent [options] [prompt]     Terminal UI
       oxbit-agent -p <prompt> [options]   Print one reply and exit
       oxbit-agent acp                     ACP agent on stdin/stdout
       oxbit-agent models                  List the provider's models
       oxbit-agent login [chatgpt]         Save an API key read from stdin
       oxbit-agent logout [provider]       Remove saved keys

Options:
  -p, --print <prompt>   Run one prompt; "-" reads it from stdin
  -m, --model <id>       Model for this run
      --provider <id>    ${PROVIDERS.join(", ")}
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
}
/** What `./tui/index.js` exports. */
export interface TuiModule {
  runTui(options: { connection: MemoryConnection; cwd: string; sessionId?: string; prompt?: string; mode?: PermissionMode;
    files: FileSystem; provider: string; version: string }): Promise<number>;
}

class UsageError extends Error {}

async function readAll(stream: Readable) {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}
/** One line from a TTY without echo, else all of stdin. */
async function readSecret(io: CliIO, label: string) {
  if (!io.stdin.isTTY || !io.stdin.setRawMode) return readAll(io.stdin);
  io.stderr.write(label);
  io.stdin.setRawMode(true);
  try {
    let text = "";
    for await (const chunk of io.stdin) {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return text;
        if (char === "\u0003") throw new UsageError("Cancelled");
        text = char === "\u007f" ? text.slice(0, -1) : text + char;
      }
    }
    return text;
  } finally {
    io.stdin.setRawMode(false);
    io.stderr.write("\n");
  }
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
    const [command, ...rest] = positionals;
    switch (command) {
      case "acp": return await acp(config, values, io, log);
      case "models": return await models(config, values, io);
      case "login": return await login(config, values, rest, io);
      case "logout": return await logout(config, values, rest, io);
    }
    const setup = (generateTitles: boolean, quiet = false): AgentSetup => ({ root: io.cwd, config, generateTitles, log: quiet ? undefined : log,
      provider: selectProvider({ provider: values.provider, model: values.model, settings: config.settings, env: io.env, storedKey: (id) => config.key(id) }) });
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
        files: nodeFilesystem(io.cwd), provider: connected.provider.id, version: agentVersion() });
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

async function acp(config: AgentConfig, values: Values, io: CliIO, log: (text: string) => void) {
  const provider = selectProvider({ provider: values.provider, model: values.model, settings: config.settings, env: io.env, storedKey: (id) => config.key(id) });
  await serveStdio({ input: io.stdin, output: io.stdout, factory: agentFactory({ root: io.cwd, config, provider, log }), log });
  return 0;
}

async function models(config: AgentConfig, values: Values, io: CliIO) {
  const provider = selectProvider({ provider: values.provider, model: values.model, settings: config.settings, env: io.env, storedKey: (id) => config.key(id) });
  if (needsKey(provider) && !provider.key) throw missingKey(provider);
  const list = await listModels(nodeModels(provider), provider.endpoint);
  for (const model of list) io.stdout.write(`${model.id === provider.model ? "*" : " "} ${model.id}${model.contextWindow ? `  ${model.contextWindow}` : ""}\n`);
  return 0;
}

async function login(config: AgentConfig, values: Values, rest: string[], io: CliIO) {
  if (rest[0] === "chatgpt") {
    io.stderr.write("Sign in with ChatGPT lands with the provider registry. Until then, use an OpenAI API key: oxbit-agent login --provider openai\n");
    return 1;
  }
  if (rest.length) throw new UsageError(`Unknown login method ${rest[0]}`);
  const id = (values.provider ?? config.settings.provider) as ProviderId | undefined;
  if (!id) throw new UsageError(`Choose a provider: oxbit-agent login --provider <${PROVIDERS.join("|")}>`);
  if (!PROVIDERS.includes(id)) throw new UsageError(`Unknown provider ${id}`);
  const key = (await readSecret(io, `API key for ${id}: `)).trim();
  if (!key) throw new UsageError("No API key on stdin");
  await config.saveKey(id, key);
  io.stdout.write(`Saved the ${id} API key in ${config.paths.auth}\n`);
  return 0;
}

async function logout(config: AgentConfig, values: Values, rest: string[], io: CliIO) {
  const id = rest[0] ?? values.provider;
  const ids = id ? [id] : PROVIDERS.filter((provider) => config.authEntry(provider));
  for (const provider of ids) await config.saveAuth(provider, undefined);
  io.stdout.write(ids.length ? `Removed saved keys for ${ids.join(", ")}\n` : "No saved keys\n");
  return 0;
}
