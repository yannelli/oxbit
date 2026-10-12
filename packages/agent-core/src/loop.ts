import type { AgentCommand, AgentTool, CommandContext, SessionView } from "./extensions.js";
import { createGoal, agentNote, type ControlExtension, type ControlOptions, type GoalOptions } from "./goal.js";

export type LoopStatus = "running" | "stopped" | "done" | "cancelled";
/** `meta.loop`. Without `intervalMs` the model paces the loop with schedule_next, which sets `nextDelayMs`. */
export interface LoopState {
  prompt: string;
  intervalMs?: number;
  nextDelayMs?: number;
  iteration: number;
  max: number;
  status: LoopStatus;
  startedAt: string;
}
export interface LoopOptions extends ControlOptions {
  /** Defaults to 100. */
  maxIterations?: number;
}
export const LOOP_MAX_ITERATIONS = 100;
export const LOOP_MAX_DELAY_MS = 3_600_000;
const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** `250ms`, `30s`, `5m` or `1h` in milliseconds; undefined for anything else. */
export function parseInterval(text: string) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(text);
  const value = match ? Number(match[1]) * UNITS[match[2]] : 0;
  return value > 0 && Number.isSafeInteger(value) ? value : undefined;
}
const format = (ms: number) => ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m`
  : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;

export function loopOf(meta: Record<string, unknown>): LoopState | undefined {
  const loop = meta.loop as LoopState | undefined;
  return loop && typeof loop === "object" && typeof loop.prompt === "string" ? loop : undefined;
}

/** Resolves true after `ms`, false when `signal` aborts first. */
const sleep = (ms: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal.aborted) return resolve(false);
  const abort = () => {
    clearTimeout(timer);
    resolve(false);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve(true);
  }, ms);
  signal.addEventListener("abort", abort, { once: true });
});

/** `/loop [interval] <prompt>`: reruns the prompt inside the command's turn until cancelled, stopped or `maxIterations`. */
export function createLoop(options: LoopOptions): ControlExtension {
  const max = options.maxIterations ?? LOOP_MAX_ITERATIONS;
  /** The prompt signal that owns each session's running loop. */
  const owners = new Map<string, AbortSignal>();
  const running = (session: SessionView) => {
    const loop = loopOf(session.meta);
    return loop?.status === "running" && owners.has(session.id) ? loop : undefined;
  };
  const finish = (session: SessionView, loop: LoopState, status: LoopStatus, text?: string) => {
    loop.status = status;
    delete loop.nextDelayMs;
    owners.delete(session.id);
    if (text) agentNote(options, session.id, text);
    return undefined;
  };
  const done = (context: CommandContext, text: string) => {
    agentNote(options, context.session.id, text);
    return { done: "end_turn" };
  };

  const command: AgentCommand = {
    name: "loop",
    description: "Run a prompt again every interval, or when the model schedules the next run",
    hint: "[30s|5m|1h] <prompt> | stop",
    async run(args, context) {
      const { session } = context;
      const loop = loopOf(session.meta);
      if (!args) return done(context, loop ? `Loop ${loop.status}: ${loop.iteration}/${loop.max} iterations of "${loop.prompt}".`
        : "No loop. Start one with /loop [interval] <prompt>.");
      if (args === "stop") {
        if (loop?.status !== "running") return done(context, "No loop is running.");
        finish(session, loop, "stopped");
        return done(context, "Loop stopped.");
      }
      const match = /^(\S+)\s+([\s\S]+)$/.exec(args);
      const interval = match ? parseInterval(match[1]) : parseInterval(args);
      const prompt = interval === undefined ? args : match?.[2].trim();
      if (!prompt) return done(context, "Usage: /loop [interval] <prompt>, for example /loop 5m check the deploy.");
      session.meta.loop = { prompt, ...interval ? { intervalMs: interval } : {}, iteration: 1, max, status: "running",
        startedAt: new Date().toISOString() } satisfies LoopState;
      owners.set(session.id, context.signal);
      agentNote(options, session.id, `Loop 1/${max}, ${interval ? `every ${format(interval)}` : "paced by the model"}. Cancel to stop it.`);
      return { prompt };
    },
  };

  const scheduleNext = (session: SessionView): AgentTool => ({
    spec: { name: "schedule_next", description: "Run the /loop prompt again after a delay. Finish without calling this tool to end the loop.",
      parameters: { type: "object", additionalProperties: false, required: ["delay_seconds"], properties: {
        delay_seconds: { type: "integer", minimum: 1, maximum: LOOP_MAX_DELAY_MS / 1000 }, reason: { type: "string" } } } },
    kind: "think",
    title: (args) => `Next loop run in ${args.delay_seconds}s`,
    async run(args) {
      const loop = running(session);
      if (!loop) throw new Error("No self-paced loop is running");
      const seconds = args.delay_seconds;
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds * 1000 > LOOP_MAX_DELAY_MS)
        throw new Error(`delay_seconds must be an integer from 1 to ${LOOP_MAX_DELAY_MS / 1000}`);
      loop.nextDelayMs = seconds * 1000;
      return `The next iteration runs in ${format(loop.nextDelayMs)}.`;
    },
  });

  return {
    commands: () => [command],
    tools(session) {
      const loop = running(session);
      return loop && loop.intervalMs === undefined ? [scheduleNext(session)] : [];
    },
    async system(session) {
      const loop = running(session);
      if (!loop) return undefined;
      return `The user started /loop. This prompt runs again ${loop.intervalMs ? `every ${format(loop.intervalMs)}` : "when you call schedule_next "
        + "before you finish; finish without calling it to end the loop"}:\n<loop_prompt>\n${loop.prompt}\n</loop_prompt>`;
    },
    async next(session, signal) {
      const loop = loopOf(session.meta);
      if (loop?.status !== "running") return undefined;
      if (owners.get(session.id) !== signal) return finish(session, loop, "stopped");
      if (signal.aborted) return finish(session, loop, "cancelled");
      if (loop.iteration >= loop.max) return finish(session, loop, "done", `Loop finished after ${loop.max} iterations.`);
      const delay = loop.intervalMs ?? loop.nextDelayMs;
      delete loop.nextDelayMs;
      if (delay === undefined) return finish(session, loop, "done", `Loop ended after ${loop.iteration} iterations: no next run was scheduled.`);
      agentNote(options, session.id, `Loop ${loop.iteration + 1}/${loop.max} in ${format(delay)}.`);
      if (!await sleep(delay, signal)) return finish(session, loop, "cancelled", "Loop cancelled.");
      if (loop.status !== "running") return undefined;
      loop.iteration++;
      return loop.prompt;
    },
  };
}

/** Goal and loop providers in the order the host passes them: goal work continues before the loop's next run. */
export function controlExtensions(options: ControlOptions & { goal?: Omit<GoalOptions, "update">; loop?: Omit<LoopOptions, "update"> }) {
  const goal = createGoal({ ...options.goal, update: options.update });
  const loop = createLoop({ ...options.loop, update: options.update });
  const order = [goal, loop];
  return { goal, loop, commands: order, tools: order, context: order, continuations: order };
}
