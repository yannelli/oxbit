import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import type { CommandContext, Params, SessionView } from "./extensions.js";
import { goalOf } from "./goal.js";
import { controlExtensions, createLoop, loopOf, parseInterval } from "./loop.js";
import { chatText, chatTool } from "./test-models.js";
import { start, testHost, text } from "./test-host.js";

const notes = (updates: Params[]) => updates.filter((update) => update.sessionUpdate === "agent_message_chunk" && update.content.text.startsWith("\n\n"))
  .map((update) => update.content.text.trim());
const users = (messages: Params[]) => messages.filter((message) => message.role === "user").map((message) => message.content as string);
function fixture(maxIterations?: number) {
  const updates: Params[] = [];
  const loop = createLoop({ update: (_id, update) => updates.push(update), maxIterations });
  const session: SessionView = { id: "s1", cwd: "/root", model: "m", turns: [], meta: {} };
  const controller = new AbortController();
  const context: CommandContext = { session, signal: controller.signal, update: () => {}, request: async () => null, replaceTurns: () => {},
    compact: async () => false };
  return { loop, session, controller, updates, run: (args: string) => loop.commands(session)[0].run(args, context) };
}
afterEach(() => void vi.useRealTimers());

describe("loop", () => {
  it("parses intervals", () => {
    expect(["250ms", "30s", "5m", "1h", "0s", "5", "5d", "m"].map(parseInterval)).toEqual([250, 30000, 300000, 3600000, undefined, undefined, undefined, undefined]);
  });
  it("starts, shows and stops a loop, and offers schedule_next only when self-paced", async () => {
    const { loop, session, updates, run } = fixture();
    expect(await run("5m")).toEqual({ done: "end_turn" });
    expect(await run("5m check the deploy")).toEqual({ prompt: "check the deploy" });
    expect(loopOf(session.meta)).toEqual(expect.objectContaining({ prompt: "check the deploy", intervalMs: 300000, iteration: 1, max: 100, status: "running" }));
    expect(await loop.tools(session)).toEqual([]);
    expect(await loop.system(session)).toContain("runs again every 5m");
    expect(await run("")).toEqual({ done: "end_turn" });
    expect(await run("stop")).toEqual({ done: "end_turn" });
    expect(await run("watch the logs")).toEqual({ prompt: "watch the logs" });
    expect((await loop.tools(session)).map((tool) => tool.spec.name)).toEqual(["schedule_next"]);
    expect(notes(updates)).toEqual(["Usage: /loop [interval] <prompt>, for example /loop 5m check the deploy.", "Loop 1/100, every 5m. Cancel to stop it.",
      'Loop running: 1/100 iterations of "check the deploy".', "Loop stopped.", "Loop 1/100, paced by the model. Cancel to stop it."]);
  });
  it("ends at the iteration cap, on cancel, without a scheduled run and for a loop from an earlier prompt", async () => {
    const capped = fixture();
    await capped.run("1ms ping");
    loopOf(capped.session.meta)!.iteration = 100;
    expect(await capped.loop.next(capped.session, capped.controller.signal)).toBeUndefined();
    expect(loopOf(capped.session.meta)!.status).toBe("done");
    expect(notes(capped.updates).at(-1)).toBe("Loop finished after 100 iterations.");

    const cancelled = fixture();
    await cancelled.run("1h ping");
    const waiting = cancelled.loop.next(cancelled.session, cancelled.controller.signal);
    cancelled.controller.abort();
    expect(await waiting).toBeUndefined();
    expect(loopOf(cancelled.session.meta)!.status).toBe("cancelled");

    const paced = fixture();
    await paced.run("ping");
    expect(await paced.loop.next(paced.session, paced.controller.signal)).toBeUndefined();
    expect(notes(paced.updates).at(-1)).toBe("Loop ended after 1 iterations: no next run was scheduled.");

    const stale = fixture();
    await stale.run("1ms ping");
    expect(await stale.loop.next(stale.session, new AbortController().signal)).toBeUndefined();
    expect(loopOf(stale.session.meta)!.status).toBe("stopped");
  });
  it("reruns the prompt every 1 ms through Agent until the cap", async () => {
    const updates: Params[] = [];
    const loop = createLoop({ update: (_id, update) => updates.push(update), maxIterations: 3 });
    const t = testHost([chatText("Green"), chatText("Green"), chatText("Red")], { extensions: { commands: [loop], continuations: [loop] } });
    const agent = new Agent(t.host);
    expect(await agent.prompt(await start(agent), text("/loop 1ms Check CI"))).toEqual({ stopReason: "end_turn" });
    expect(users(t.messages())).toEqual(["Check CI", "Check CI", "Check CI"]);
    expect(notes(updates)).toEqual(["Loop 1/3, every 1ms. Cancel to stop it.", "Loop 2/3 in 1ms.", "Loop 3/3 in 1ms.", "Loop finished after 3 iterations."]);
  });
  it("lets the model pace the loop with schedule_next and ends when it does not call it", async () => {
    vi.useFakeTimers();
    const updates: Params[] = [];
    const loop = createLoop({ update: (_id, update) => updates.push(update) });
    const t = testHost([chatTool("call_1", "schedule_next", { delay_seconds: 90 }), chatText("Queue busy"), chatText("Queue empty")],
      { extensions: { commands: [loop], tools: [loop], context: [loop], continuations: [loop] } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    let finished = false;
    const pending = agent.prompt(sessionId, text("/loop Poll the queue")).finally(() => void (finished = true));
    for (let tick = 0; tick < 20 && !finished; tick++) await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({ stopReason: "end_turn" });
    expect(t.messages(0)[0].content).toContain("when you call schedule_next");
    expect(users(t.messages())).toEqual(["Poll the queue", "Poll the queue"]);
    expect(notes(updates)).toEqual(["Loop 1/100, paced by the model. Cancel to stop it.", "Loop 2/100 in 90s.",
      "Loop ended after 2 iterations: no next run was scheduled."]);
  });
  it("continues an active goal before the loop's next run", async () => {
    const updates: Params[] = [];
    const controls = controlExtensions({ update: (_id, update) => updates.push(update), goal: { maxContinuations: 1 }, loop: { maxIterations: 2 } });
    const t = testHost([chatText("Started"), chatText("More"), chatText("CI green"), chatTool("call_1", "update_goal", { status: "complete" }),
      chatText("Goal done"), chatText("CI green again")], { extensions: controls });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    await agent.prompt(sessionId, text("/goal Fix the bug"));
    expect(await agent.prompt(sessionId, text("/loop 1ms Check CI"))).toEqual({ stopReason: "end_turn" });
    const goalTurn = "Continue working toward the active goal.";
    expect(users(t.messages()).map((content) => content.startsWith(goalTurn) ? "goal" : content))
      .toEqual(["Fix the bug", "goal", "Check CI", "goal", "Check CI"]);
    expect(notes(updates)).toEqual(["Goal set: Fix the bug", "Continuing the goal (1/1).",
      "The goal is still active after 1 continuations. Send a message or /goal resume to continue.", "Loop 1/2, every 1ms. Cancel to stop it.",
      "Continuing the goal (1/1).", "Goal complete.", "Loop 2/2 in 1ms.", "Loop finished after 2 iterations."]);
    const meta = (agent as any).sessions.get(sessionId).meta;
    expect([goalOf(meta)!.status, loopOf(meta)!.status]).toEqual(["complete", "done"]);
  });
});
