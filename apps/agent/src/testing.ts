import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { AgentExtensions } from "@oxbit/agent-core";
import { fakeModels, type Reply } from "@oxbit/agent-core/test-models";
import { AgentConfig } from "./config.js";
import { agentFactory, type AgentSetup } from "./host.js";
import type { ProviderChoice } from "./providers.js";

/** A new directory under the OS temp dir, with symlinks resolved so it matches session cwds. */
export const tempDir = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)));

/** A Node host setup over scripted model replies, a temp agent home and a temp root. */
export async function testSetup(replies: Reply[], options: { root?: string; extensions?: AgentExtensions } = {}) {
  const home = await tempDir("oxa-home-");
  const root = options.root ?? await tempDir("oxa-root-");
  const config = await AgentConfig.load(home);
  const fake = fakeModels(replies);
  const provider: ProviderChoice = { id: "openai-compatible", endpoint: { api: "openai-compatible", baseUrl: "https://models.test/api" },
    base: "https://models.test/api", model: "model-a" };
  const setup: AgentSetup = { root, config, provider, models: fake.models, generateTitles: false, extensions: options.extensions };
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
