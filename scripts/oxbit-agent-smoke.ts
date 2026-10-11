// Runs one Oxbit Agent turn against a model server: `bun scripts/oxbit-agent-smoke.ts <api> <model> [baseUrl]`.
// The default base URL is a local Ollama, which serves all three APIs; set OXBIT_AGENT_KEY for a hosted API.
import type { AgentModelRequest, AgentModels, FeatureOptions } from "@oxbit/sdk";
import { LocalAgentRuntime } from "../packages/features/agent-acp/src/local/runtime.ts";

const [api, model, base = "http://localhost:11434"] = process.argv.slice(2);
if (!["openai", "anthropic", "openai-compatible"].includes(api) || !model) {
  console.error("Usage: bun scripts/oxbit-agent-smoke.ts <openai|anthropic|openai-compatible> <model> [baseUrl]");
  process.exit(2);
}
const key = process.env.OXBIT_AGENT_KEY ?? "local";
const files: Record<string, string> = { "notes.txt": "pelican is the secret word\n" };

const models: AgentModels = {
  async *stream(request: AgentModelRequest, signal?: AbortSignal) {
    const prefix = request.api === "openai-compatible" ? new URL(request.baseUrl!).pathname.replace(/\/$/, "") : "";
    const response = await fetch(new URL(prefix + request.path, base), {
      method: request.method,
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(request.api === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` }),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, body: await response.text() });
    const decoder = new TextDecoder();
    for await (const chunk of response.body!) yield decoder.decode(chunk, { stream: true });
  },
  keys: { has: async () => true, save: async () => {}, remove: async () => {} },
};

const settings: Record<string, unknown> = { "agentACP.oxbit.api": api, "agentACP.oxbit.baseUrl": base, "agentACP.oxbit.model": model };
const options = {
  kernel: { configuration: { get: (id: string) => settings[id], set: (id: string, value: unknown) => void (settings[id] = value) } },
  filesystem: { id: "smoke", root: "/smoke", list: async () => Object.keys(files).map((name) => ({ name, path: name, kind: "file" })) },
} as unknown as FeatureOptions;
const runtime = new LocalAgentRuntime(options, () => models);
let text = "";
const tools: string[] = [];
runtime.subscribe("acp.update", ({ update }) => {
  if (update.sessionUpdate === "agent_message_chunk") text += update.content?.text ?? "";
  if (update.sessionUpdate === "tool_call") tools.push(update.title);
});
runtime.subscribe("acp.request", ({ id, requestId, method, params }) => {
  const content = method === "fs/read_text_file" ? files[params.path] : undefined;
  void runtime.request("acp.respond", content === undefined ? { id, requestId, error: `${method} is read-only in the smoke test` } : { id, requestId, result: { content } });
});

const started = await runtime.request<{ id: string }>("acp.start", { provider: "oxbit" });
await runtime.request("acp.call", { id: started.id, method: "session/new" });
const result = await runtime.request("acp.call", {
  id: started.id,
  method: "session/prompt",
  params: { messageId: "smoke", text: "Call the read_file tool on notes.txt, then tell me the secret word in one sentence." },
});
runtime.dispose();
console.log(JSON.stringify({ api, model, result, tools, text: text.trim() }));
if (!tools.length || !/pelican/i.test(text)) process.exit(1);
