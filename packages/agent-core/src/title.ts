import type { AgentHost } from "./host.js";
import type { Turn } from "./model.js";
import { streamStep } from "./step.js";
import { ADAPTERS, type LiveSession } from "./turn.js";

const PROMPT = "Write a 3 to 7 word title for this coding conversation. Reply with the title only.";
const INPUT_LIMIT = 2000;

/** The first user message and the start of the reply after it, capped at 2000 characters. */
export function titleInput(turns: readonly Turn[]) {
  const first = turns.findIndex((turn) => turn.role === "user");
  const reply = turns.slice(first + 1).find((turn) => turn.role === "assistant" && turn.text);
  if (first < 0 || reply?.role !== "assistant") return undefined;
  return `User: ${(turns[first] as { text: string }).text}\n\nAssistant: ${reply.text}`.slice(0, INPUT_LIMIT);
}

/** First line without wrapping quotes or trailing punctuation, at most 80 characters. */
export function cleanTitle(text: string) {
  const line = text.trim().split("\n")[0].trim();
  return line.replace(/^["'`“‘\s]+/, "").replace(/["'`”’\s.!?,;:]+$/, "").slice(0, 80).trim();
}

/** Asks the session's model for a title. Resolves undefined on any failure. */
export async function generateTitle(host: AgentHost, session: LiveSession, signal: AbortSignal) {
  try {
    const input = titleInput(session.turns);
    const models = host.models();
    const endpoint = host.endpoint();
    const adapter = ADAPTERS[endpoint.api];
    if (!input || !models || !adapter || !session.model) return undefined;
    const result = await streamStep({ adapter, models, endpoint, signal, update: () => {}, turns: [],
      input: { model: session.model, system: PROMPT, turns: [{ role: "user", text: input }], tools: [], maxTokens: 30 } });
    return result.stop ? cleanTitle(result.turn.text) || undefined : undefined;
  } catch {
    return undefined;
  }
}
