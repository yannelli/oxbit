import {
  useRef,
  useId,
  useSyncExternalStore,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import type { ACPSubagent } from "@oxbit/sdk";
import { Icon, translate as tr } from "@oxbit/ui";
import type { AgentController, AgentRequest } from "./controller.js";
import { Markdown } from "./views.js";

const states = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  disconnected: "Disconnected",
  unknown: "Unknown",
};
const phases = {
  unknown: "",
  thinking: "Thinking",
  executing_tools: "Executing tools",
  responding: "Responding",
  awaiting_input: "Awaiting input",
};
export function childStatus(child: ACPSubagent) {
  return tr(
    child.phase !== "unknown" &&
      ["pending", "running", "unknown"].includes(child.state)
      ? phases[child.phase]
      : (states[child.state] ?? "Unknown"),
  );
}
export function Subagents({
  agent,
  compact = false,
  renderRequest,
}: {
  agent: AgentController;
  compact?: boolean;
  renderRequest?: (request: AgentRequest) => ReactNode;
}) {
  useSyncExternalStore(agent.subscribe, agent.snapshot);
  const tree = useRef<HTMLUListElement>(null);
  const treeId = useId();
  const children = [...agent.subagents.values()].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  const selected = agent.subagents.get(agent.selectedSubagent ?? "");
  const selectedId = selected?.id ?? children[0]?.id;
  const counts = {
    completed: children.filter((c) => c.state === "completed").length,
    failed: children.filter((c) => c.state === "failed").length,
  };
  const hasChildren = (id: string) => children.some((c) => c.parentId === id);
  const keyboard = (event: KeyboardEvent, child: ACPSubagent) => {
    const rows = [
      ...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ??
        []),
    ];
    const index = rows.indexOf(event.currentTarget as HTMLElement);
    let target: HTMLElement | undefined;
    if (event.key === "ArrowDown")
      target = rows[Math.min(rows.length - 1, index + 1)];
    else if (event.key === "ArrowUp") target = rows[Math.max(0, index - 1)];
    else if (event.key === "Home") target = rows[0];
    else if (event.key === "End") target = rows.at(-1);
    else if (event.key === "ArrowRight") {
      if (hasChildren(child.id) && !agent.expandedSubagents.has(child.id))
        agent.toggleSubagent(child.id);
      else if (hasChildren(child.id)) target = rows[index + 1];
    } else if (event.key === "ArrowLeft") {
      if (hasChildren(child.id) && agent.expandedSubagents.has(child.id))
        agent.toggleSubagent(child.id);
      else target = rows.find((r) => r.dataset.childId === child.parentId);
    } else if (event.key === "Enter" || event.key === " ")
      agent.selectSubagent(child.id);
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (target) {
      agent.selectSubagent(target.dataset.childId!);
      target.focus();
    }
  };
  const renderTree = (
    parentId?: string,
    ancestors = new Set<string>(),
  ): ReactNode =>
    children
      .filter(
        (c) =>
          (agent.subagents.has(c.parentId ?? "") ? c.parentId : undefined) ===
          parentId,
      )
      .filter((c) => !ancestors.has(c.id))
      .map((child) => {
        const expanded = agent.expandedSubagents.has(child.id);
        return (
          <li role="none" key={child.id}>
            <div
              role="treeitem"
              data-child-id={child.id}
              aria-selected={selectedId === child.id}
              aria-level={ancestors.size + 1}
              aria-owns={
                hasChildren(child.id) && expanded
                  ? `${treeId}:${child.id}`
                  : undefined
              }
              aria-expanded={hasChildren(child.id) ? expanded : undefined}
              aria-label={`${child.name} · ${childStatus(child)}${child.historical ? ` · ${tr("Historical")}` : ""}`}
              tabIndex={selectedId === child.id ? 0 : -1}
              className="acp-agent-row"
              onKeyDown={(event) => keyboard(event, child)}
              onClick={() => agent.selectSubagent(child.id)}
            >
              {hasChildren(child.id) ? (
                <button
                  className="icon-button"
                  tabIndex={-1}
                  aria-label={tr(
                    expanded ? "Collapse subagents" : "Expand subagents",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    agent.toggleSubagent(child.id);
                  }}
                >
                  {expanded ? "▾" : "▸"}
                </button>
              ) : (
                <Icon name="agent" size={15} />
              )}
              <span className="acp-agent-name">
                {child.name}
                <small>{child.task || tr("Delegated task")}</small>
              </span>
              <span className="acp-agent-state" data-state={child.state}>
                {childStatus(child)}
                {child.historical && <small>{tr("Historical")}</small>}
              </span>
            </div>
            {hasChildren(child.id) && expanded && (
              <ul role="group" id={`${treeId}:${child.id}`}>
                {renderTree(child.id, new Set([...ancestors, child.id]))}
              </ul>
            )}
          </li>
        );
      });
  const detail = selected ?? (!compact ? children[0] : undefined);
  const requests = detail
    ? agent.requests.filter(
        (r) =>
          r.subagentId === detail.id ||
          (!!detail.sessionId && r.sessionId === detail.sessionId),
      )
    : [];
  return (
    <section
      className={compact ? "acp-subagents" : "acp-panel acp-agents-view"}
      aria-label={tr(compact ? "Conversation subagents" : "Agents")}
    >
      <div className="acp-agents-heading">
        {compact ? (
          <button
            className="button"
            aria-expanded={agent.subagentsOpen}
            onClick={() => {
              agent.subagentsOpen = !agent.subagentsOpen;
              agent.changed();
            }}
          >
            {tr("Subagents")} · {children.length}
          </button>
        ) : (
          <h2>{tr("Agents")}</h2>
        )}
        <span className="acp-agents-counts" role="status">
          {agent.activeSubagentCount} {tr("active")} · {counts.completed}{" "}
          {tr("completed")} · {counts.failed} {tr("failed")}
        </span>
        {compact && (
          <button className="button" onClick={() => agent.openAgents()}>
            {tr("Open Agents")}
          </button>
        )}
      </div>
      {!compact && (
        <p className="muted acp-agents-conversation">{agent.title}</p>
      )}
      {(!compact || agent.subagentsOpen) && (
        <>
          {!children.length && (
            <div className="acp-agents-empty">
              <Icon name="agent" size={28} />
              <p>{tr("Subagents appear when your agent delegates a task.")}</p>
              <button
                className="button"
                onClick={() => agent.options.workbench.openPanel("agent-acp")}
              >
                {tr("Open conversation")}
              </button>
            </div>
          )}
          {agent.subagentsTruncated && (
            <p className="muted">
              {tr(
                "Some earlier subagent records were omitted to keep history bounded.",
              )}
            </p>
          )}
          {!!children.length && (
            <div className="acp-agents-layout">
              <ul
                className="acp-agent-tree"
                role="tree"
                aria-label={tr("Dispatched subagents")}
                ref={tree}
              >
                {renderTree()}
              </ul>
              {detail && (
                <section
                  className="acp-agent-detail"
                  aria-label={tr("Subagent details")}
                >
                  <h3>{detail.name}</h3>
                  <p className="acp-agent-meta">
                    <span className="acp-agent-state" data-state={detail.state}>
                      {childStatus(detail)}
                    </span>{" "}
                    · {detail.provider}
                    {detail.model ? ` · ${detail.model}` : ""}
                  </p>
                  {detail.historical && (
                    <p className="acp-agent-disclosure">
                      {tr(
                        "Historical activity. Live status has not been confirmed.",
                      )}
                    </p>
                  )}
                  {detail.visibility === "limited" && (
                    <p className="acp-agent-disclosure">
                      {tr("Limited visibility")}:{" "}
                      {tr(
                        "Only activity reported by the adapter is available. A returned task does not confirm that a background agent has finished.",
                      )}
                    </p>
                  )}
                  <p className="muted">
                    {tr("Evidence")}:{" "}
                    {tr(
                      detail.evidence === "native"
                        ? "Child session events"
                        : detail.evidence === "provider"
                          ? "Provider metadata"
                          : "Delegation tool events",
                    )}
                  </p>
                  {detail.task && (
                    <details open>
                      <summary>{tr("Delegated task")}</summary>
                      <pre>{detail.task}</pre>
                    </details>
                  )}
                  <p className="muted">
                    {tr("Last observed activity")}:{" "}
                    <time dateTime={detail.updatedAt}>
                      {new Date(detail.updatedAt).toLocaleString()}
                    </time>
                    {detail.durationMs !== undefined
                      ? ` · ${(detail.durationMs / 1000).toFixed(1)}s`
                      : ""}
                  </p>
                  {requests.length > 0 && (
                    <div className="acp-agent-requests">
                      {renderRequest ? (
                        requests.map(renderRequest)
                      ) : (
                        <button
                          className="button primary"
                          onClick={() => agent.openAgents(detail.id)}
                        >
                          {tr("Review subagent requests")} ({requests.length})
                        </button>
                      )}
                    </div>
                  )}
                  {detail.result && (
                    <details open={detail.state === "completed"}>
                      <summary>
                        {tr(
                          detail.state === "completed"
                            ? "Result"
                            : detail.evidence === "tool"
                              ? "Returned tool output"
                              : "Latest response",
                        )}
                      </summary>
                      <Markdown text={detail.result} agent={agent} />
                    </details>
                  )}
                  <details
                    className="acp-child-history"
                    open={
                      !detail.result ||
                      ["pending", "running", "unknown"].includes(detail.state)
                    }
                  >
                    <summary>
                      {tr("Activity")} · {detail.activity.length}
                    </summary>
                    <div
                      className="acp-child-activity"
                      aria-label={tr("Subagent activity")}
                    >
                      {detail.activity.map((entry) =>
                        entry.kind === "message" ? (
                          entry.role === "thought" ? (
                            <details key={entry.id}>
                              <summary>{tr("Thinking")}</summary>
                              <Markdown text={entry.text ?? ""} agent={agent} />
                            </details>
                          ) : (
                            <article key={entry.id}>
                              <strong>
                                {tr(entry.role === "user" ? "You" : "Agent")}
                              </strong>
                              <Markdown text={entry.text ?? ""} agent={agent} />
                            </article>
                          )
                        ) : (
                          <details key={entry.id} className="acp-card">
                            <summary>
                              {entry.title ?? tr("Agent tool")}{" "}
                              {entry.status && (
                                <span className="muted">
                                  · {tr(entry.status)}
                                </span>
                              )}
                            </summary>
                            {entry.text && <pre>{entry.text}</pre>}
                            {entry.input && (
                              <details>
                                <summary>{tr("Tool input")}</summary>
                                <pre>{entry.input}</pre>
                              </details>
                            )}
                            {entry.output && (
                              <details open>
                                <summary>{tr("Tool output")}</summary>
                                <pre>{entry.output}</pre>
                              </details>
                            )}
                            {entry.locations?.map((location, i) => (
                              <button
                                className="button"
                                key={i}
                                onClick={() =>
                                  void agent.action(() =>
                                    agent.openLocation(
                                      location.path,
                                      location.line,
                                    ),
                                  )
                                }
                              >
                                {location.path}
                              </button>
                            ))}
                          </details>
                        ),
                      )}
                    </div>
                  </details>
                  {!detail.activity.length && (
                    <p className="muted">
                      {tr("No child activity was provided by this adapter.")}
                    </p>
                  )}
                  {detail.truncated && (
                    <p className="muted">
                      {tr("Earlier subagent activity was truncated.")}
                    </p>
                  )}
                </section>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
