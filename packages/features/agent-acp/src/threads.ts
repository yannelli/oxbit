import type { ACPLiveSession } from "@oxbit/sdk";
import type { AgentController } from "./controller.js";

export const AGENT_LIMIT_STATUS = "Agent limit reached";
export type ThreadState = "attention" | "working" | "ready";

/** The runtime rejects `acp.start` with BUSY when the device already runs its maximum number of agents. */
export const agentLimit = (error: unknown) =>
  (error as { code?: unknown } | undefined)?.code === "BUSY";

/** Pending requests in live threads other than the one the panel shows. */
export const backgroundRequests = (sessions: ACPLiveSession[], currentId?: string) =>
  sessions.reduce(
    (sum, session) => (session.connection.id === currentId ? sum : sum + session.pendingRequests),
    0,
  );

/** Runtime sessions, plus the panel's connection until the next list refresh includes it. */
export function liveThreads(agent: AgentController): ACPLiveSession[] {
  const current = agent.connection;
  if (!current || agent.liveSessions.some((session) => session.connection.id === current.id))
    return agent.liveSessions;
  return [
    ...agent.liveSessions,
    {
      connection: current,
      busy: agent.busy,
      title: agent.title,
      pendingRequests: agent.requests.length,
      queued: agent.queue.length,
    },
  ];
}

/** The panel's own state is newer than the polled list, so the current thread uses it. */
export function threadState(agent: AgentController, session: ACPLiveSession) {
  const current = session.connection.id === agent.connection?.id;
  const pending = current ? agent.requests.length : session.pendingRequests;
  const busy = current ? agent.busy : session.busy;
  const state: ThreadState = pending ? "attention" : busy ? "working" : "ready";
  return { current, pending, state, title: (current ? agent.title : session.title) || "New conversation" };
}

/** Two or more threads, or a running thread the panel does not show, or the start limit. */
export function showThreads(agent: AgentController) {
  const threads = liveThreads(agent);
  return (
    threads.length >= 2 ||
    (threads.length > 0 && (!agent.connection || agent.status === AGENT_LIMIT_STATUS))
  );
}

export function refreshThreads(agent: AgentController) {
  if (agent.options.runtime?.connected) void agent.listLiveSessions().catch(() => {});
}

export async function stopThread(agent: AgentController, id: string) {
  if (id === agent.connection?.id) return agent.disconnect();
  const runtime = agent.options.runtime;
  if (!runtime?.connected) throw new Error("Connect to a runtime workspace first");
  await runtime.request("acp.stop", { id });
  agent.liveSessions = agent.liveSessions.filter((session) => session.connection.id !== id);
  if (agent.status === AGENT_LIMIT_STATUS) agent.status = "Disconnected";
  agent.changed();
  await agent.listLiveSessions();
}

/** Polls `acp.list` while the panel is visible or other threads run, so their status and requests stay current. */
export function watchThreads(agent: AgentController, visible: () => boolean, interval = 4000) {
  const timer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    const others = agent.liveSessions.some((session) => session.connection.id !== agent.connection?.id);
    if (others || visible()) refreshThreads(agent);
  }, interval);
  return { dispose: () => clearInterval(timer) };
}
