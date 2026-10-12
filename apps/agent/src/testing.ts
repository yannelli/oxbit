import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { provider as providerRuntime, type AgentExtensions } from "@oxbit/agent-core";
import { fakeModels, type Reply } from "@oxbit/agent-core/test-models";
import { FileAuthStore } from "./auth.js";
import { AgentConfig } from "./config.js";
import { agentFactory, type AgentSetup } from "./host.js";
import type { ProviderChoice } from "./providers.js";
import type { PanelContext } from "./tui/connection.js";

/** A new directory under the OS temp dir, with symlinks resolved so it matches session cwds. */
export const tempDir = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)));

/** A Node host setup over scripted model replies, a temp agent home and a temp root. */
export async function testSetup(replies: Reply[], options: { root?: string; extensions?: AgentExtensions } = {}) {
  const home = await tempDir("oxa-home-");
  const root = options.root ?? await tempDir("oxa-root-");
  const config = await AgentConfig.load(home);
  const fake = fakeModels(replies);
  const runtime = providerRuntime({ provider: "openai-compatible", method: "none", baseUrl: "https://models.test/api" },
    { fetch: () => Promise.reject(new Error("Tests use fakeModels")), auth: new FileAuthStore(join(home, "auth.json")) });
  const provider: ProviderChoice = { id: "openai-compatible", runtime, model: "model-a", ready: true };
  const setup: AgentSetup = { root, config, provider, models: fake.models, generateTitles: false, extensions: options.extensions, userHome: home };
  return { home, root, config, setup, fake, factory: agentFactory(setup) };
}

/** A Writable stand-in that keeps what was written. */
export function sink() {
  const stream = { text: "", write(chunk: string) {
    stream.text += chunk;
    return true;
  } };
  return stream as typeof stream & Writable;
}

/** A 2025-06-18 stdio MCP server script with one `echo` tool, in a temp dir. */
export async function echoServer() {
  const path = join(await tempDir("oxa-mcp-"), "server.mjs");
  await writeFile(path, `import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize")
    return send({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  if (message.method === "tools/list")
    return send({ id: message.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  if (message.method === "tools/call") return send({ id: message.id, result: { content: [{ type: "text", text: "echo: " + message.params.arguments.text }] } });
  send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`);
  return path;
}

/** A PanelContext for `cwd` that keeps progress text. */
export function panelContext(cwd: string) {
  const progress: string[] = [];
  const context: PanelContext = { cwd, signal: new AbortController().signal, progress: (text) => void progress.push(text) };
  return Object.assign(context, { shown: progress });
}
