import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { httpModels } from "./providers/models.js";
import { isTransient, retryAfterMs, type RetryPolicy } from "./retry.js";
import { chatText, type Reply } from "./test-models.js";
import { start, testHost, text } from "./test-host.js";

const httpFail = (status: number, body = "", extra: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${status}`), { status, body, ...extra });
const failing = (error: unknown): Reply => () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) });

function setup(replies: Reply[], retry: RetryPolicy = {}) {
  const delays: number[] = [];
  const t = testHost(replies, { host: { retry: { sleep: async (ms) => (delays.push(ms), true), ...retry } } });
  const notices = () => t.updates.map((update) => update.content?.text ?? "").filter((value: string) => value.includes("Retrying"));
  return { ...t, delays, notices, agent: new Agent(t.host) };
}

describe("model request retries", () => {
  it("retries a 503 with backoff and a 429 after its Retry-After, then answers", async () => {
    const t = setup([failing(httpFail(503, '{"error":{"message":"overloaded"}}')), failing(httpFail(429, "", { retryAfterMs: 2500 })), chatText("Ok")]);
    const sessionId = await start(t.agent);
    expect(await t.agent.prompt(sessionId, text("Hi"))).toEqual({ stopReason: "end_turn" });
    expect(t.posts()).toHaveLength(3);
    expect(t.delays).toEqual([1000, 2500]);
    expect(t.notices()).toEqual(["\n\nModel API error 503: overloaded. Retrying in 1 s (1 of 4).\n\n", "\n\nModel API error 429. Retrying in 2.5 s (2 of 4).\n\n"]);
    expect(t.messages().slice(1)).toEqual([{ role: "user", content: "Hi" }]);
  });
  it("gives up after the retry cap and leaves the session usable", async () => {
    const t = setup([failing(httpFail(502)), failing(httpFail(502)), failing(httpFail(502)), chatText("Back")], { retries: 2 });
    const sessionId = await start(t.agent);
    await expect(t.agent.prompt(sessionId, text("Hi"))).rejects.toThrow("Model API error 502");
    expect(t.posts()).toHaveLength(3);
    expect(t.delays).toEqual([1000, 2000]);
    expect(await t.agent.prompt(sessionId, text("Retry"))).toEqual({ stopReason: "end_turn" });
    expect(t.messages().slice(1)).toEqual([{ role: "user", content: "Retry" }]);
  });
  it("does not retry after streamed output, or for errors that are not transient", async () => {
    const partial: Reply = async function* () {
      yield* chatText("Partial").slice(0, 1);
      throw new TypeError("Load failed");
    };
    const t = setup([partial, failing(httpFail(400, "context too long")), failing(httpFail(429, '{"error":{"code":"insufficient_quota"}}')),
      failing(httpFail(503, "", { retryAfterMs: 120000 })), failing(new Error("No scripted model reply"))]);
    const sessionId = await start(t.agent);
    await expect(t.agent.prompt(sessionId, text("One"))).rejects.toThrow("Load failed");
    for (const message of ["Model API error 400", "Model API error 429", "Model API error 503", "No scripted model reply"])
      await expect(t.agent.prompt(sessionId, text("Next"))).rejects.toThrow(message);
    expect(t.posts()).toHaveLength(5);
    expect(t.delays).toEqual([]);
    expect(t.updates.filter((update) => update.sessionUpdate === "agent_message_chunk").map((update) => update.content.text)).toEqual(["Partial"]);
  });
  it("retries a network failure and stops waiting when the turn is cancelled", async () => {
    const t = testHost([failing(new TypeError("Load failed"))], { host: { retry: { baseMs: 20000 } } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    const turn = agent.prompt(sessionId, text("Hi"));
    await expect.poll(() => t.updates.some((update) => update.content?.text?.includes("Retrying in 20 s (1 of 4)"))).toBe(true);
    agent.cancel(sessionId);
    expect(await turn).toEqual({ stopReason: "cancelled" });
    expect(t.posts()).toHaveLength(1);
  });
  it("classifies statuses, overload messages and Retry-After values", async () => {
    expect([408, 409, 429, 500, 529, 400, 401, 501].map((status) => isTransient(httpFail(status)))).toEqual([true, true, true, true, true, false, false, false]);
    expect([new Error("Overloaded"), new Error("The network connection was lost."), new Error("Invalid JSON")].map(isTransient)).toEqual([true, true, false]);
    expect(retryAfterMs({ headers: new Headers({ "retry-after": "3" }) })).toBe(3000);
    expect(retryAfterMs({ headers: { "Retry-After-Ms": "250" } })).toBe(250);
    expect(retryAfterMs({ retryAfter: new Date(Date.now() + 10000).toUTCString() })).toBeGreaterThan(8000);
    const models = httpModels({ fetch: async () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
      credentials: { get: async () => "key" }, keys: { has: async () => true, save: async () => {}, remove: async () => {} } });
    const stream = models.stream({ api: "openai", method: "POST", path: "/v1/responses", body: {} })[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toMatchObject({ status: 429, body: "slow down", retryAfterMs: 7000 });
  });
});
