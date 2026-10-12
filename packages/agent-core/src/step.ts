import type { AgentModelEndpoint, AgentModels } from "@oxbit/sdk";
import type { Params } from "./extensions.js";
import { modelError, type ModelAdapter, type ModelInput, type StopReason, type ToolCall, type Turn } from "./model.js";

export type AssistantTurn = Extract<Turn, { role: "assistant" }>;
export interface StepResult {
  turn: AssistantTurn;
  /** Undefined when the request was cancelled. */
  stop?: StopReason;
  usage?: { input: number; output: number };
}
export interface StepOptions {
  adapter: ModelAdapter;
  models: AgentModels;
  endpoint: AgentModelEndpoint;
  input: ModelInput;
  signal: AbortSignal;
  /** Receives the turn when it has text or calls, even when the stream fails. */
  turns: Turn[];
  update(update: Params): void;
  contextWindow?: number;
}

/** Ends iteration when `signal` aborts, even if the host stream ignores the signal. */
async function* abortable<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("Cancelled"));
    else signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void iterator.return?.()?.catch(() => {});
  }
}

/** Streams one model response and reports text, reasoning and usage as ACP session updates. */
export async function streamStep({ adapter, models, endpoint, input, signal, turns, update, contextWindow }: StepOptions): Promise<StepResult> {
  const calls: ToolCall[] = [];
  const turn: AssistantTurn = { role: "assistant", text: "", calls };
  const result: StepResult = { turn };
  try {
    const request = adapter.request(input);
    for await (const event of adapter.events(abortable(models.stream({ ...endpoint, ...request }, signal), signal))) {
      if (event.type === "text") {
        turn.text += event.text;
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } });
      } else if (event.type === "reasoning")
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } });
      else if (event.type === "tool_call") calls.push(event.call);
      else if (event.type === "usage") {
        result.usage = { input: event.input, output: event.output };
        if (contextWindow) update({ sessionUpdate: "usage_update", used: event.input + event.output, size: contextWindow });
      } else if (event.type === "stop") {
        result.stop = event.reason;
        if (event.native) turn.native = { api: endpoint.api, items: event.native };
      }
    }
    if (!result.stop && !signal.aborted) throw new Error("The model stream ended before the response finished");
  } catch (error) {
    if (!signal.aborted) throw modelError(error);
  } finally {
    // Calls from an unfinished response never run and lack the API's reasoning items.
    if (!result.stop) calls.length = 0;
    if (turn.text || calls.length) turns.push(turn);
  }
  return result;
}
