import type { AgentModelEndpoint, AgentModels } from "@oxbit/sdk";
import { ADAPTERS } from "./agent.js";

const SYSTEM = "Write a 3 to 7 word title for this coding conversation. Reply with the title only.";

/** The first non-empty line without wrapping quotes or trailing punctuation, at most 80 characters. */
export function cleanTitle(text: string) {
  const line = text.split("\n").map((item) => item.trim()).find(Boolean) ?? "";
  return line.replace(/\s+/g, " ").replace(/^["'“”‘’\s]+|["'“”‘’.,;:!?…。\s]+$/g, "").slice(0, 80).trimEnd();
}

/** One model request for a conversation title from the first message and the start of the reply. */
export async function generateTitle(models: AgentModels, endpoint: AgentModelEndpoint, model: string, prompt: string, reply: string) {
  const adapter = ADAPTERS[endpoint.api];
  const text = `User: ${prompt}\n\nAgent: ${reply.slice(0, 1000)}`;
  const request = adapter.request({ model, system: SYSTEM, turns: [{ role: "user", text }], tools: [], maxTokens: 30 });
  let title = "";
  for await (const event of adapter.events(models.stream({ ...endpoint, ...request })))
    if (event.type === "text") title += event.text;
  return cleanTitle(title);
}
