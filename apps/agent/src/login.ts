import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { CHATGPT, CHATGPT_LABELS, ChatGPTAuth, PROVIDERS, apiKeySlot, planEnabled, providerSpec, type Fetch } from "@oxbit/agent-core";
import type { FileAuthStore } from "./auth.js";
import type { CliIO } from "./cli.js";
import type { AgentConfig } from "./config.js";
import { nodeLoopback } from "./loopback.js";
import { chatgptSignedIn, missingKey, normalizeBase, selectProvider, type ProviderChoice, type ProviderInput } from "./providers.js";

export class UsageError extends Error {}

export interface AuthCommand {
  config: AgentConfig;
  auth: FileAuthStore;
  io: CliIO;
  /** The selection input from flags, settings and the environment. */
  input: ProviderInput;
}

export const SIGN_IN_TIMEOUT_MS = 10 * 60000;
export const fetchOr = (custom?: Fetch): Fetch => custom ?? ((url, init) => fetch(url, init));

/** The selection that stores `id`'s API key. Throws for a provider without keys and for openai-compatible without a base URL. */
export async function apiKeyChoice(input: ProviderInput, id: string) {
  const spec = providerSpec(id);
  if (!spec) throw new UsageError(`Unknown provider ${id}`);
  if (!spec.methods.some((method) => method.id === "api-key")) throw new UsageError(`${spec.name} does not use an API key`);
  return selectProvider({ ...input, provider: spec.id, method: "api-key" });
}
/** Saves `key` in auth.json and switches a saved non-key method for the provider to api-key. */
export async function saveApiKey(config: AgentConfig, choice: ProviderChoice, key: string) {
  await choice.runtime.models().keys.save(choice.runtime.endpoint(), key);
  const own = config.settings.providers?.[choice.id];
  if (own?.method && own.method !== "api-key")
    await config.saveSettings({ providers: { ...config.settings.providers, [choice.id]: { ...own, method: "api-key" } } });
}
/** Deletes saved API keys for `id`, or for every provider without it; openai-compatible without a base URL drops every origin's key. Returns the removed slot names. */
export async function removeApiKeys(auth: FileAuthStore, input: Pick<ProviderInput, "settings" | "env">, id?: string) {
  const removed: string[] = [];
  const drop = async (slot: string) => {
    if (!await auth.get(slot)) return;
    await auth.delete(slot);
    removed.push(slot.slice("apikey:".length));
  };
  const spec = id === undefined ? undefined : providerSpec(id);
  if (id !== undefined && !spec) throw new UsageError(`Unknown provider ${id}`);
  const base = spec?.id === "openai-compatible" ? input.settings.providers?.[spec.id]?.baseUrl || input.env.OXBIT_AGENT_BASE_URL : undefined;
  if (spec && spec.id !== "openai-compatible") await drop(apiKeySlot(spec.id));
  else if (base) await drop(apiKeySlot("openai-compatible", normalizeBase(base)));
  else for (const slot of await auth.keys()) if (slot.startsWith(spec ? `apikey:${spec.id} ` : "apikey:")) await drop(slot);
  return removed;
}
/** Signs out of ChatGPT. Resolves undefined without a sign-in, else whether OpenAI confirmed the revocation. */
export async function signOutChatGPT(auth: FileAuthStore, fetch: Fetch) {
  if (!await chatgptSignedIn(auth)) return undefined;
  return (await new ChatGPTAuth({ fetch, store: auth }).signOut()).revoked;
}
export interface ChatGPTSignIn {
  config: AgentConfig;
  auth: FileAuthStore;
  fetch: Fetch;
  signal: AbortSignal;
  /** Shows or opens the sign-in page. */
  open(url: string): void | Promise<void>;
  paste?(signal: AbortSignal): Promise<string>;
}
/** Runs Sign in with ChatGPT. With plan use allowed, saves providers.openai.method = chatgpt, and provider = openai when settings name none. */
export async function signInChatGPT({ config, auth, fetch, signal, open, paste }: ChatGPTSignIn) {
  const chatgpt = new ChatGPTAuth({ fetch, store: auth });
  const record = await chatgpt.record();
  const account = await chatgpt.signIn({ loopback: nodeLoopback, account: record.active, paste, signal, open: (address) => {
    const url = new URL(address);
    url.searchParams.delete("id_token_hint");
    return open(url.toString());
  } });
  if (!planEnabled(account)) return { account, enabled: false };
  const providers = config.settings.providers ?? {};
  await config.saveSettings({ ...config.settings.provider ? {} : { provider: "openai" }, providers: { ...providers, openai: { ...providers.openai, method: "chatgpt" } } });
  return { account, enabled: true };
}

export async function readAll(stream: Readable) {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}
/** One line from a TTY without echo, else all of stdin. */
export async function readSecret(io: CliIO, label: string) {
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

/** The first non-empty line of `stdin`. Stays pending at end of input, so the browser callback can still finish the sign-in. */
function pastedLine(stdin: Readable, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: stdin, crlfDelay: Infinity });
    const stop = () => {
      lines.close();
      reject(new Error("The sign-in ended"));
    };
    signal.addEventListener("abort", stop, { once: true });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      signal.removeEventListener("abort", stop);
      lines.close();
      resolve(line.trim());
    });
  });
}

/** Opens `url` with `open` on macOS or `xdg-open` on Linux. Resolves false when the opener fails or there is no local display. */
export function openBrowser(url: string, env: CliIO["env"]): Promise<boolean> {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  const remote = !!(env.SSH_CONNECTION || env.SSH_TTY) || (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY);
  if (!command || remote) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
    setTimeout(() => resolve(true), 3000).unref();
    child.unref();
  });
}

/** Lists each provider's sign-in methods and the command for each. */
export function methodList() {
  const lines = ["Sign-in methods:"];
  for (const spec of PROVIDERS)
    for (const method of spec.methods) {
      const command = method.id === "chatgpt" ? "oxbit-agent login chatgpt" : method.id === "api-key" ? `oxbit-agent login --provider ${spec.id}` : "no sign-in needed";
      lines.push(`  ${spec.name.padEnd(18)} ${method.label.padEnd(24)} ${command}`);
      if (method.detail) lines.push(`  ${"".padEnd(18)} ${method.detail}`);
    }
  return `${lines.join("\n")}\n`;
}

export async function login({ config, auth, io, input }: AuthCommand, rest: string[]) {
  if (rest[0] === "chatgpt" && rest.length === 1) return loginChatGPT({ config, auth, io, input });
  if (rest.length) throw new UsageError(`Unknown login method ${rest.join(" ")}. Run oxbit-agent login to list the methods`);
  if (!input.provider) return void io.stdout.write(methodList()), 0;
  const spec = providerSpec(input.provider);
  if (!spec) throw new UsageError(`Unknown provider ${input.provider}`);
  const choice = await apiKeyChoice(input, spec.id);
  const key = (await readSecret(io, `${spec.methods.find((method) => method.id === "api-key")!.label}: `)).trim();
  if (!key) throw new UsageError("No API key on stdin");
  await saveApiKey(config, choice, key);
  io.stdout.write(`Saved the ${spec.name} API key in ${auth.path}\n`);
  return 0;
}

async function loginChatGPT({ config, auth, io }: AuthCommand) {
  let noBrowser!: () => void;
  const failed = new Promise<void>((resolve) => (noBrowser = resolve));
  io.stderr.write(`${CHATGPT_LABELS.signIn}\n`);
  const { account, enabled } = await signInChatGPT({
    config, auth, fetch: fetchOr(io.fetch),
    open: async (url) => {
      io.stderr.write(`Open this page to sign in:\n${url}\n`);
      if (await (io.open ?? ((target: string) => openBrowser(target, io.env)))(url)) return;
      io.stderr.write(`No browser opened. After you sign in, paste the address the browser lands on (it starts with ${new URL(url).searchParams.get("redirect_uri")}):\n`);
      noBrowser();
    },
    paste: (signal) => failed.then(() => pastedLine(io.stdin, signal)),
    signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
  });
  if (!enabled) {
    io.stderr.write("You are signed in, but ChatGPT plan use was not allowed. Run oxbit-agent login chatgpt again and allow it, or use an OpenAI API key.\n");
    return 1;
  }
  io.stdout.write(`${CHATGPT_LABELS.welcome}${account.email ? ` (${account.email})` : ""}.\n${CHATGPT_LABELS.manage}: ${CHATGPT.usageUrl}\n`);
  if (config.settings.provider !== "openai") io.stdout.write(`settings.json selects ${config.settings.provider}; run with --provider openai to use your ChatGPT plan.\n`);
  return 0;
}

export async function logout({ auth, io, input }: AuthCommand, rest: string[]) {
  if (rest.length > 1) throw new UsageError(`Unexpected argument ${rest[1]}`);
  const target = rest[0] ?? input.provider;
  const removed = target === "chatgpt" ? [] : await removeApiKeys(auth, input, target);
  if (!target || target === "chatgpt") {
    const revoked = await signOutChatGPT(auth, fetchOr(io.fetch));
    if (revoked !== undefined) removed.push(revoked ? "ChatGPT" : "ChatGPT (signed out here; OpenAI did not confirm the revocation)");
  }
  io.stdout.write(removed.length ? `Removed ${removed.join(", ")}\n` : "Nothing to remove\n");
  return 0;
}

/** The provider's models with context windows; `*` marks the selected model. */
export async function models({ io, input }: AuthCommand) {
  const choice = await selectProvider(input);
  if (!choice.ready) throw missingKey(choice);
  const list = await choice.runtime.catalog();
  io.stderr.write(`${choice.runtime.label}\n`);
  const width = Math.max(0, ...list.map((model) => model.id.length));
  for (const model of list) {
    const window = model.contextWindow ? `  ${model.contextWindow.toLocaleString("en-US")} tokens` : "";
    io.stdout.write(`${model.id === choice.model ? "*" : " "} ${model.id.padEnd(window ? width : 0)}${window}\n`);
  }
  return 0;
}
