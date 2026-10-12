import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import type { CommandContext, Params, SessionView } from "./extensions.js";
import { createGoal, goalOf, GOAL_MAX_CONTINUATIONS, type GoalState } from "./goal.js";
import { chatText, chatTool } from "./test-models.js";
import { start, testHost, text } from "./test-host.js";

const notes = (updates: Params[]) => updates.filter((update) => update.sessionUpdate === "agent_message_chunk" && update.content.text.startsWith("\n\n"))
  .map((update) => update.content.text.trim());
function fixture(options: { tokenBudget?: number } = {}) {
  const updates: Params[] = [];
  const goal = createGoal({ update: (_id, update) => updates.push(update), ...options });
  const session: SessionView & { turns: any[] } = { id: "s1", cwd: "/root", model: "m", turns: [], meta: {} };
  const signal = new AbortController().signal;
  const context: CommandContext = { session, signal, update: () => {}, request: async () => null, replaceTurns: () => {}, compact: async () => false };
  const command = goal.commands(session)[0];
  return { goal, session, signal, updates, run: (args: string) => command.run(args, context) };
}

describe("goal", () => {
  it("sets, shows, pauses, resumes and clears the goal in session meta", async () => {
    const { goal, session, updates, run } = fixture();
    expect(await run("")).toEqual({ done: "end_turn" });
    expect(await run("Make the tests pass")).toEqual({ prompt: "Make the tests pass" });
    expect(goalOf(session.meta)).toEqual(expect.objectContaining({ objective: "Make the tests pass", status: "active", continuations: 0, tokensUsed: 0 }));
    expect(await goal.system(session)).toContain("<goal>\nMake the tests pass\n</goal>");
    expect((await goal.tools(session)).map((tool) => tool.spec.name)).toEqual(["update_goal"]);
    expect(await run("pause")).toEqual({ done: "end_turn" });
    expect(await goal.system(session)).toBeUndefined();
    expect(await goal.tools(session)).toEqual([]);
    expect(await run("resume")).toEqual({ prompt: expect.stringContaining("Completion audit:") });
    expect(await run("clear")).toEqual({ done: "end_turn" });
    expect(session.meta.goal).toBeUndefined();
    expect(await run("x".repeat(4001))).toEqual({ done: "end_turn" });
    expect(notes(updates)).toEqual(["No goal is set. Start one with /goal <objective>.", "Goal set: Make the tests pass", "Goal paused.", "Goal resumed.",
      "Goal cleared.", "Keep the objective under 4000 characters."]);
  });
  it("continues at most 50 times per prompt and starts over on the next prompt", async () => {
    const { goal, session, signal, updates, run } = fixture();
    await run("Ship it");
    const results = [];
    for (let index = 0; index < GOAL_MAX_CONTINUATIONS + 2; index++) results.push(await goal.next(session, signal));
    expect(results.filter((value) => value?.includes("<objective>\nShip it\n</objective>"))).toHaveLength(50);
    expect(results.slice(50)).toEqual([undefined, undefined]);
    expect(notes(updates).at(-1)).toBe("The goal is still active after 50 continuations. Send a message or /goal resume to continue.");
    expect(notes(updates).filter((note) => note.startsWith("The goal is still active"))).toHaveLength(1);
    expect(await goal.next(session, new AbortController().signal)).toContain("Completion audit:");
    expect(goalOf(session.meta)!.continuations).toBe(51);
  });
  it("stops at the token budget with an estimate from the new turns", async () => {
    const { goal, session, signal, updates, run } = fixture({ tokenBudget: 20 });
    session.turns.push({ role: "user", text: "old ".repeat(100) });
    await run("Refactor");
    session.turns.push({ role: "user", text: "Refactor" }, { role: "assistant", text: "a".repeat(32), calls: [] });
    expect(await goal.next(session, signal)).toContain("Tokens used: about 11 of a 20 token budget (9 left)");
    session.turns.push({ role: "assistant", text: "b".repeat(40), calls: [] });
    expect(await goal.next(session, signal)).toBeUndefined();
    expect(goalOf(session.meta)).toEqual(expect.objectContaining({ status: "budget_limited", tokensUsed: 22 }));
    expect(notes(updates).at(-1)).toBe("Goal stopped: about 22 tokens used of the 20 token budget.");
  });
  it("continues twice through Agent, then completes with update_goal", async () => {
    const updates: Params[] = [];
    const goal = createGoal({ update: (_id, update) => updates.push(update) });
    const t = testHost([chatText("Step one"), chatText("Step two"), chatTool("call_1", "update_goal", { status: "complete", note: "Tests pass" }),
      chatText("Done")], { extensions: { commands: [goal], tools: [goal], context: [goal], continuations: [goal] } });
    const agent = new Agent(t.host);
    const sessionId = await start(agent);
    expect(await agent.prompt(sessionId, text("/goal Fix the parser"))).toEqual({ stopReason: "end_turn" });
    const first = t.messages(0);
    expect(first[0].content).toContain("<goal>\nFix the parser\n</goal>");
    expect(first[1]).toEqual({ role: "user", content: "Fix the parser" });
    const users = t.messages().filter((message) => message.role === "user").map((message) => message.content);
    expect(users).toHaveLength(3);
    expect(users.slice(1).every((content) => content.startsWith("Continue working toward the active goal."))).toBe(true);
    expect(t.messages().at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: expect.stringContaining("Goal status: complete.") });
    expect(notes(updates)).toEqual(["Goal set: Fix the parser", "Continuing the goal (1/50).", "Continuing the goal (2/50).", "Goal complete: Tests pass"]);
    expect((await goal.tools({ id: sessionId, cwd: "/root", model: "", turns: [], meta: { goal: { status: "complete" } as GoalState } }))).toEqual([]);
  });
});
