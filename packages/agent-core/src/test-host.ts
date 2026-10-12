import type { Agent } from "./agent.js";
import type { AgentExtensions, HookEvent, HookOutcome, HookRunner, Params } from "./extensions.js";
import type { AgentHost } from "./host.js";
import { fakeModels, type Reply } from "./test-models.js";

export interface HostOptions {
  extensions?: AgentExtensions;
  terminal?: boolean;
  files?: Record<string, string>;
  /** Answers a client request; undefined falls through to the in-memory files. */
  respond?(method: string, params: Params): unknown;
  host?: Partial<AgentHost>;
}

/** An AgentHost over scripted model replies, in-memory files and recorded client requests. */
export function testHost(replies: Reply[], options: HostOptions = {}) {
  const fake = fakeModels(replies);
  const updates: Params[] = [];
  const client: [string, Params][] = [];
  const files: Record<string, string> = { ...options.files };
  const host: AgentHost = {
    models: () => fake.models, endpoint: () => ({ api: "openai-compatible", baseUrl: "https://models.test/api" }),
    capabilities: { fs: true, terminal: options.terminal ?? false },
    filesystem: { id: "root", list: async () => [] } as any, root: "/root",
    update: (_sessionId, update) => updates.push(update),
    request: async (method, params) => {
      client.push([method, params]);
      const answer = await options.respond?.(method, params);
      if (answer !== undefined) return answer;
      if (method === "fs/read_text_file") return { content: files[params.path] ?? "" };
      if (method === "fs/write_text_file") files[params.path] = params.content;
      return null;
    },
    extensions: options.extensions, generateTitles: false,
    ...options.host,
  };
  const posts = () => fake.requests.filter((request) => request.method === "POST");
  const messages = (index = -1) => (posts().at(index)!.body as any).messages as Params[];
  return { host, updates, client, files, posts, messages, ...fake };
}

export function hooks(handler: (event: HookEvent, input: Params) => HookOutcome | undefined = () => undefined) {
  const calls: [HookEvent, Params][] = [];
  const runner: HookRunner = {
    run: async (event, input) => {
      calls.push([event, input]);
      return handler(event, input) ?? {};
    },
  };
  return { runner, calls, events: () => calls.map(([event]) => event) };
}

export const text = (value: string) => [{ type: "text", text: value }];
export async function start(agent: Agent, params: Params = {}) {
  const { sessionId } = await agent.newSession(params);
  return sessionId;
}
