import { useEffect, type RefObject } from "react";
import { IconButton, translate as tr } from "@oxbit/ui";
import type { AgentController } from "./controller.js";
import { agentName } from "./launch.js";
import { liveThreads, refreshThreads, showThreads, stopThread, threadState } from "./threads.js";
import "./thread-strip.css";

/** Refreshes the thread list when the panel mounts, changes thread, or gains focus. */
export function useThreadRefresh(agent: AgentController, panel: RefObject<HTMLElement | null>) {
  const connectionId = agent.connection?.id;
  useEffect(() => refreshThreads(agent), [connectionId]);
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    let last = 0;
    const focused = () => {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      refreshThreads(agent);
    };
    node.addEventListener("focusin", focused);
    return () => node.removeEventListener("focusin", focused);
  }, []);
}

/** One chip per live runtime agent. Selecting a chip attaches the panel to that agent. */
export function ThreadStrip({ agent, onNew }: { agent: AgentController; onNew(): void }) {
  if (!showThreads(agent)) return null;
  return (
    <nav className="acp-threads" aria-label={tr("Agent threads")}>
      {liveThreads(agent).map((session) => {
        const id = session.connection.id;
        const { current, pending, state, title } = threadState(agent, session);
        const label = tr(title);
        const status =
          state === "attention"
            ? tr("Needs input ({0})", { 0: pending })
            : tr(state === "working" ? "Working…" : "Ready");
        const stop = async () => {
          const choice = await agent.options.workbench.ask(
            tr("Stop thread"),
            tr("Stop {0}? Its agent process ends on the runtime.", { 0: label }),
            [tr("Stop"), tr("Cancel")],
            true,
          );
          if (choice === tr("Stop")) await stopThread(agent, id);
        };
        return (
          <div className="acp-thread-chip" data-current={current || undefined} key={id}>
            <button
              type="button"
              className="acp-thread-select"
              aria-current={current ? "true" : undefined}
              onClick={() => {
                if (!current) void agent.action(() => agent.attachLive(id));
              }}
            >
              <span className="acp-dot" data-state={state} aria-hidden="true" />
              <span className="acp-thread-text">
                <strong>{label}</strong>
                <small>
                  {status} · {agentName(session.connection.provider, session.connection)}
                </small>
              </span>
            </button>
            <IconButton
              icon="stop"
              label={tr("Stop {0}", { 0: label })}
              onClick={() => void agent.action(stop)}
            />
          </div>
        );
      })}
      <IconButton
        icon="plus"
        label="New thread"
        className="icon-button acp-thread-new"
        disabled={!agent.connection || agent.connecting}
        onClick={onNew}
      />
    </nav>
  );
}
