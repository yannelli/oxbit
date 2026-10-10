import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ACP_CUSTOM_PROVIDER,
  ACP_PROVIDERS,
  acpPreset,
  type Extension,
  type FeatureOptions,
} from "@oxbit/sdk";
import { Icon, IconButton, Select, translate as tr } from "@oxbit/ui";
import { AgentController, type AgentRequest } from "./controller.js";
import { AgentPicker, CustomAgentForm, type Chooser } from "./agent-picker.js";
import { ContextMeter } from "./context-meter.js";
import { RegistryBrowser } from "./registry-browser.js";
import { AgentSetup } from "./setup.js";
import { OverflowMenu, type MenuItem } from "./overflow-menu.js";
import { agentName } from "./launch.js";
import { AGENT_VIEW } from "./attention.js";
import { sessionControls } from "./session-controls.js";
import { ComposerInput, SendHint, type ComposerActions } from "./composer-input.js";
import { searchFiles } from "./mentions.js";
import { imageFiles } from "./images.js";
import {
  ActivityFeed,
  FilePatch,
  ConversationBrowser,
  ContextPicker,
  ContextItem,
  ChangeSummary,
} from "./views.js";

import { Subagents } from "./subagents.js";
import { ThreadStrip, useThreadRefresh } from "./thread-strip.js";
import { watchThreads } from "./threads.js";
import { agentConfiguration } from "./configuration.js";
function RequestCard({
  request,
  agent,
  full = false,
}: {
  request: AgentRequest;
  agent: AgentController;
  full?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await agent.action(fn);
    setBusy(false);
  };
  const { params, method } = request;
  return (
    <section className="acp-approval" aria-label={tr("Agent approval")}>
      <strong>
        <Icon name="warning" size={14} />{" "}
        {tr(
          method === "fs/write_text_file"
            ? "Review file change"
            : method === "cursor/ask_question"
              ? "Agent needs your input"
              : method === "cursor/create_plan"
                ? "Review plan"
                : "Permission required",
        )}
      </strong>
      {request.subagentId && (
        <p className="acp-request-agent">
          {tr("From subagent")}:{" "}
          {agent.subagents.get(request.subagentId)?.name ?? request.subagentId}
        </p>
      )}
      {method === "fs/write_text_file" ? (
        <>
          <p>{params.path}</p>
          <FilePatch
            path={params.path}
            before={request.before ?? ""}
            after={params.content}
          />
          {!full && (
            <button
              className="button"
              onClick={() =>
                agent.options.workbench.openView(
                  `acp-review:${request.requestId}`,
                  params.path + " · Agent review",
                  FileReview,
                  { agent, requestId: request.requestId },
                )
              }
            >
              {tr("Review in editor")}
            </button>
          )}
          <div className="acp-actions">
            <button
              className="button primary"
              disabled={busy || !agent.requests.includes(request)}
              onClick={() => void run(() => agent.applyFile(request))}
            >
              {tr("Apply change")}
            </button>
            <button
              className="button"
              disabled={busy || !agent.requests.includes(request)}
              onClick={() =>
                void run(() =>
                  agent.respond(
                    request,
                    undefined,
                    "User rejected the file change",
                  ),
                )
              }
            >
              {tr("Reject")}
            </button>
          </div>
        </>
      ) : method === "session/request_permission" ? (
        <>
          <p>{params.toolCall?.title || tr("Agent tool")}</p>
          {params.toolCall?.rawInput && (
            <details>
              <summary>{tr("Tool input")}</summary>
              <pre>{JSON.stringify(params.toolCall.rawInput, null, 2)}</pre>
            </details>
          )}
          {params.toolCall?.content?.map((item: any, index: number) =>
            item.type === "diff" ? (
              <div className="acp-request-diff" key={index}>
                <p>{item.path}</p>
                <FilePatch
                  path={item.path}
                  before={item.oldText ?? ""}
                  after={item.newText ?? ""}
                />
              </div>
            ) : item.content?.text ? (
              <pre key={index}>{item.content.text}</pre>
            ) : null,
          )}
          <div className="acp-actions">
            {(params.options ?? []).map((option: any) => (
              <button
                className="button"
                key={option.optionId}
                disabled={busy || !agent.requests.includes(request)}
                onClick={() =>
                  void run(() =>
                    agent.respond(request, {
                      outcome: {
                        outcome: "selected",
                        optionId: option.optionId,
                      },
                    }),
                  )
                }
              >
                {option.name}
              </button>
            ))}
            <button
              className="button"
              disabled={busy || !agent.requests.includes(request)}
              onClick={() =>
                void run(() =>
                  agent.respond(request, { outcome: { outcome: "cancelled" } }),
                )
              }
            >
              {tr("Cancel")}
            </button>
          </div>
        </>
      ) : method === "cursor/create_plan" ? (
        <>
          <p>{params.name}</p>
          <pre>{params.plan}</pre>
          <div className="acp-actions">
            {["accepted", "rejected"].map((outcome) => (
              <button
                className="button"
                key={outcome}
                disabled={busy || !agent.requests.includes(request)}
                onClick={() =>
                  void run(() =>
                    agent.respond(request, { outcome: { outcome } }),
                  )
                }
              >
                {tr(outcome === "accepted" ? "Approve plan" : "Reject plan")}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          {(params.questions ?? []).map((question: any) => (
            <fieldset key={question.id}>
              <legend>{question.prompt}</legend>
              {(question.options ?? []).map((option: any) => (
                <label key={option.id} className="acp-choice">
                  <input
                    type={question.allowMultiple ? "checkbox" : "radio"}
                    name={request.requestId + question.id}
                    checked={(answers[question.id] ?? []).includes(option.id)}
                    onChange={(event) =>
                      setAnswers({
                        ...answers,
                        [question.id]: question.allowMultiple
                          ? event.target.checked
                            ? [...(answers[question.id] ?? []), option.id]
                            : (answers[question.id] ?? []).filter(
                                (id) => id !== option.id,
                              )
                          : [option.id],
                      })
                    }
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          ))}
          <div className="acp-actions">
            <button
              className="button primary"
              disabled={
                busy ||
                (params.questions ?? []).some(
                  (q: any) => !answers[q.id]?.length,
                )
              }
              onClick={() =>
                void run(() =>
                  agent.respond(request, {
                    outcome: {
                      outcome: "answered",
                      answers: Object.entries(answers).map(
                        ([questionId, selectedOptionIds]) => ({
                          questionId,
                          selectedOptionIds,
                        }),
                      ),
                    },
                  }),
                )
              }
            >
              {tr("Submit answers")}
            </button>
            <button
              className="button"
              disabled={busy || !agent.requests.includes(request)}
              onClick={() =>
                void run(() =>
                  agent.respond(request, { outcome: { outcome: "skipped" } }),
                )
              }
            >
              {tr("Skip")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
function FileReview({
  agent,
  requestId,
}: {
  agent: AgentController;
  requestId: string;
}) {
  useSyncExternalStore(agent.subscribe, agent.snapshot);
  const request = agent.requests.find((r) => r.requestId === requestId);
  return (
    <div className="acp-panel acp-review-editor">
      {request ? (
        <RequestCard request={request} agent={agent} full />
      ) : (
        <p role="status">{tr("This review is complete or has expired.")}</p>
      )}
    </div>
  );
}

function AgentPanel({ agent }: { agent: AgentController }) {
  useSyncExternalStore(agent.subscribe, agent.snapshot);
  const { kernel, runtime } = agent.options;
  const [showSetup, setShowSetup] = useState(false);
  const [chooser, setChooser] = useState<Chooser>();
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? undefined : Notification.permission,
  );
  const panel = useRef<HTMLDivElement>(null);
  const chooserRef = useRef<HTMLDivElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [following, setFollowing] = useState(true);
  const contextId = useId();
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const composerActions = useRef<ComposerActions>(null);
  const contextTrigger = useRef<HTMLButtonElement>(null);
  const contextPopup = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const settingsFocus = useRef<HTMLElement | null>(null);
  const follow = useRef(true);
  const connection = agent.connection;
  const enabled = !!runtime?.connected;
  const controls = sessionControls(connection);
  const settingsDisabled =
    agent.busy ||
    agent.connecting ||
    agent.updatingSettings ||
    agent.discovering ||
    agent.archived;
  useEffect(() => {
    const popup = contextPopup.current;
    if (!showContext || !popup || !contextTrigger.current) return;
    const rect = contextTrigger.current.getBoundingClientRect();
    const width = Math.min(320, innerWidth - 16);
    const upward = rect.top > innerHeight - rect.bottom;
    Object.assign(popup.style, {
      width: `${width}px`,
      maxHeight: `${Math.max(80, (upward ? rect.top : innerHeight - rect.bottom) - 12)}px`,
      left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`,
      top: upward ? "auto" : `${rect.bottom + 4}px`,
      bottom: upward ? `${innerHeight - rect.top + 4}px` : "auto",
    });
    popup.showPopover();
    popup.querySelector("button")?.focus();
    const dismiss = () => setShowContext(false);
    window.addEventListener("resize", dismiss);
    return () => {
      popup.hidePopover();
      window.removeEventListener("resize", dismiss);
    };
  }, [showContext]);
  useEffect(() => {
    if (contextPopup.current?.matches(":popover-open")) {
      setShowContext(false);
      contextTrigger.current?.focus();
    }
  }, [agent.context.length]);
  useEffect(() => {
    if (settingsDisabled) return;
    const trigger = settingsFocus.current;
    settingsFocus.current = null;
    // Temporarily disabling the focused button blurs it. Restore keyboard
    // navigation only if the user has not moved focus to another control.
    if (trigger?.isConnected && document.activeElement === document.body)
      trigger.focus();
  }, [settingsDisabled]);
  useEffect(() => {
    if (follow.current && transcript.current && agent.messages.length)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [agent.snapshot()]);
  useEffect(() => {
    const node = panel.current;
    agent.markSeen();
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) agent.markSeen();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useThreadRefresh(agent, panel);
  const newThread = () => {
    setChooser(undefined);
    void agent.action(() => agent.detach());
  };
  const chosen = agent.chosen.provider;
  useEffect(() => {
    if (enabled && !agent.registry && !acpPreset(chosen) && chosen !== ACP_CUSTOM_PROVIDER)
      void agent.loadRegistry().catch(() => {});
  }, [enabled, chosen]);
  useEffect(() => {
    if (chooser) chooserRef.current?.scrollIntoView({ block: "nearest" });
  }, [chooser]);
  const status = agent.requests.length
    ? "attention"
    : agent.busy || agent.connecting
      ? "working"
      : /failed/i.test(agent.status)
        ? "error"
        : connection
          ? "ready"
          : "off";
  const menu: MenuItem[] = [
    ...(enabled
      ? [{
          id: "live", label: "Runtime sessions", icon: "agentChat",
          run: () => {
            setShowLive(!showLive);
            if (!showLive) void agent.action(() => agent.listLiveSessions());
          },
        }]
      : []),
    { id: "agents", label: "Open Agents", icon: "agent", run: () => agent.openAgents() },
    { id: "setup", label: "Agent setup", icon: "gear", run: () => setShowSetup(!showSetup) },
    ...(connection
      ? [{ id: "thread", label: "New thread", icon: "plus", run: newThread },
         { id: "disconnect", label: "Disconnect", icon: "power", run: () => void agent.action(() => agent.disconnect()) }]
      : []),
    ...(permission === "default"
      ? [{
          id: "notifications", label: "Enable desktop notifications", icon: "bell",
          run: () => void Notification.requestPermission().then(setPermission),
        }]
      : []),
  ];
  const chooserView =
    chooser === "registry" ? (
      <RegistryBrowser agent={agent} onDone={() => setChooser(undefined)} />
    ) : chooser === "custom" ? (
      <CustomAgentForm agent={agent} onDone={() => setChooser(undefined)} />
    ) : undefined;
  return (
    <div className="acp-panel" ref={panel}>
      <ThreadStrip agent={agent} onNew={newThread} />
      <div className="acp-header">
        <div className="acp-thread-heading">
          <strong title={agent.title}>{tr(agent.title)}</strong>
          <div className="acp-status" role="status" data-state={status} title={tr(agent.status)}>
            <span className={agent.busy ? "acp-dot working" : "acp-dot"} data-state={status} />
            <span className="acp-status-text">{tr(agent.status)}</span>
          </div>
          {!connection && (agent.messages.length > 0 || agent.archived) && (
            <button
              className="button acp-connect"
              data-tooltip={tr("Start {0}", { 0: agent.displayName })}
              disabled={!enabled || agent.connecting}
              onClick={() => void agent.action(() => agent.connectSelected())}
            >
              {tr(agent.connecting ? "Connecting…" : "Connect")}
            </button>
          )}
          {agent.connecting && (
            <IconButton
              icon="x"
              label="Cancel"
              onClick={() => void agent.action(() => agent.disconnect())}
            />
          )}
          {connection?.sessionId && (
            <IconButton
              icon="plus"
              label="New conversation"
              disabled={
                agent.busy ||
                agent.connecting ||
                agent.updatingSettings ||
                agent.discovering ||
                agent.queue.length > 0 ||
                agent.activeSubagentCount > 0
              }
              onClick={() => void agent.action(() => agent.newSession())}
            />
          )}
          <IconButton
            icon="clock"
            label="History"
            aria-expanded={showHistory}
            onClick={() => setShowHistory(!showHistory)}
          />
          <OverflowMenu label="More agent actions" items={menu} />
        </div>
        {!enabled && (
          <p className="muted">
            {tr("Connect to a runtime workspace to use agents.")}{" "}
            <button
              className="button"
              onClick={() =>
                void agent.action(() =>
                  kernel.commands.execute("workspace.runtime"),
                )
              }
            >
              {tr("Runtime connection")}
            </button>
          </p>
        )}
        {showSetup && <AgentSetup key={connection?.provider ?? chosen} agent={agent} />}
        {connection && !connection.sessionId && (
          <div className="acp-actions">
            {connection.authMethods.map((method) => (
              <button
                className="button"
                disabled={agent.connecting}
                key={method.id}
                onClick={() =>
                  void agent.action(() => agent.authenticate(method.id))
                }
              >
                {tr("Sign in")}: {method.name}
              </button>
            ))}
            <button
              className="button"
              disabled={agent.connecting}
              onClick={() => void agent.action(() => agent.newSession())}
            >
              {tr("Retry conversation")}
            </button>
          </div>
        )}
        {showHistory && <ConversationBrowser agent={agent} />}
        {showLive && <section className="acp-live-sessions" aria-label={tr("Runtime sessions")}>
          {agent.liveSessions.length === 0 && <p className="muted">{tr("No running conversations")}</p>}
          {agent.liveSessions.map(session => <div className="acp-live-session" key={session.connection.id}>
            <span><strong>{session.title || tr("New conversation")}</strong><small className="muted">{agentName(session.connection.provider, session.connection)} · {session.busy ? tr("Working…") : tr("Ready")}{session.queued ? ` · ${session.queued} ${tr("queued")}` : ""}</small></span>
            <button type="button" className="button" disabled={agent.connection?.id === session.connection.id}
              onClick={() => void agent.action(async () => { await agent.attachLive(session.connection.id); setShowLive(false); })}>
              {tr(agent.connection?.id === session.connection.id ? "Current" : "Open")}
            </button>
          </div>)}
        </section>}
        {agent.error && (
          <p role="alert" className="error-text">
            {agent.error}
          </p>
        )}
      </div>
      <div
        className="acp-content"
        ref={transcript}
        onScroll={() => {
          const node = transcript.current;
          if (node)
            follow.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          setFollowing(follow.current);
        }}
      >
        {!agent.messages.length && chooserView}
        {!agent.messages.length && !chooserView && !connection && !agent.archived && (
          <AgentPicker agent={agent} enabled={enabled} onChoose={setChooser} />
        )}
        {!agent.messages.length && !chooserView && (connection || agent.archived) && (
          <div className="acp-welcome">
            <Icon name="agentChat" size={28} />
            <h2>{tr("Work with your agent")}</h2>
            <p>
              {tr(
                "Ask a question, plan a change, or attach code from your editor. Follow tool calls and review approvals here.",
              )}
            </p>
          </div>
        )}
        {agent.replayTruncated && <p className="acp-turn-note" role="status">{tr("Earlier activity was trimmed by the runtime.")}</p>}
        {agent.subagents.size > 0 && <Subagents agent={agent} compact />}
        <ActivityFeed agent={agent} />
        {agent.plan.length > 0 && (
          <details className="acp-card">
            <summary>
              {tr("Plan")} ·{" "}
              {agent.plan.filter((e) => e.status === "completed").length}/
              {agent.plan.length}
            </summary>
            <ol>
              {agent.plan.map((entry, index) => (
                <li key={index}>
                  <span className="muted">{tr(entry.status)} · </span>
                  {entry.content}
                </li>
              ))}
            </ol>
          </details>
        )}
        {Array.from(agent.terminals.entries()).map(([id, terminal]) => (
          <details className="acp-card" key={id}>
            <summary>
              {tr("Terminal")}: {terminal.command} ·{" "}
              {terminal.exitStatus ? tr("Ended") : tr("Running")}
            </summary>
            <pre>{terminal.output}</pre>
            {terminal.truncated && (
              <p className="muted">{tr("Earlier output was truncated")}</p>
            )}
          </details>
        ))}
        <ChangeSummary agent={agent} />
        {agent.requests.map((request) => (
          <RequestCard
            key={request.requestId}
            request={request}
            agent={agent}
          />
        ))}
        {agent.logs && (
          <details className="acp-card">
            <summary>{tr("Agent logs")}</summary>
            <pre>{agent.logs}</pre>
          </details>
        )}
        {agent.messages.length > 0 && chooserView && <div ref={chooserRef}>{chooserView}</div>}
      </div>
      {!following && (
        <button
          className="button acp-jump"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            if (transcript.current)
              transcript.current.scrollTop = transcript.current.scrollHeight;
          }}
        >
          {tr("Jump to latest")}
        </button>
      )}
      {agent.requests.length > 0 && (
        <button
          className="button acp-attention"
          onClick={() => {
            transcript.current
              ?.querySelector(".acp-approval")
              ?.scrollIntoView({ block: "center" });
            (
              transcript.current?.querySelector(
                ".acp-approval button",
              ) as HTMLElement
            )?.focus();
          }}
        >
          {tr("Agent needs your input")} · {agent.requests.length}
        </button>
      )}
      {agent.queue.length > 0 && <section className="acp-queue" aria-label={tr("Queued messages")}>
        <div className="acp-queue-heading"><strong>{tr("Queued messages")} · {agent.queue.length}</strong>
          {agent.queuePaused && <button className="button" type="button" onClick={() => void agent.action(() => agent.resumeQueue())}>{tr("Run queue")}</button>}
        </div>
        {agent.queue.map((prompt, index) => <div className="acp-queue-item" key={prompt.id}>
          <span title={prompt.text}>{index + 1}. {prompt.text}</span>
          <IconButton icon="pencil" label={tr("Edit queued message")} onClick={() => void agent.action(() => agent.editQueued(prompt.id))} />
          <IconButton icon="x" label={tr("Remove queued message")} onClick={() => void agent.action(() => agent.removeQueued(prompt.id))} />
        </div>)}
      </section>}
      <form
        className="acp-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void agent.action(() => agent.send());
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = imageFiles(event.dataTransfer);
          if (!files.length) return;
          event.preventDefault();
          void agent.action(async () => {
            for (const file of files) await agent.attachImage(file);
          });
        }}
      >
        <div
          id={contextId}
          ref={contextPopup}
          popover="auto"
          className="acp-context-menu"
          role="region"
          aria-label={tr("Add context")}
          onToggle={(event) => {
            if (event.newState === "closed") setShowContext(false);
          }}
        >
          <button
            type="button"
            className="button"
            onClick={() => void agent.action(() => agent.attachDiagnostics())}
          >
            <Icon name="warning" size={14} />
            {tr("Attach diagnostics")}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void agent.action(() => agent.attachChanges())}
          >
            <Icon name="git" size={14} />
            {tr("Attach changes")}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void agent.action(() => agent.attach())}
          >
            <Icon name="files" size={14} />
            {tr("Attach file")}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void agent.action(() => agent.attach(true))}
          >
            <Icon name="focus" size={14} />
            {tr("Attach selection")}
          </button>
          {showContext && <ContextPicker agent={agent} />}
        </div>
        {agent.context.length > 0 && (
          <div className="acp-attachments">
            {agent.context.map((context, index) => (
              <div className="acp-context-chip" key={index}>
                <ContextItem item={context} />
                <IconButton
                  icon="x"
                  label={tr("Remove attachment {0}", {
                    0: context.kind === "changes" ? tr("Uncommitted changes") : context.path,
                  })}
                  onClick={() => {
                    agent.context.splice(index, 1);
                    agent.changed();
                  }}
                />
              </div>
            ))}
            <p className="acp-context-budget muted">
              {agent.context.length}/8 {tr("attachments")} ·{" "}
              {(
                agent.draft.length +
                agent.context.reduce((n, c) => n + c.text.length, 0)
              ).toLocaleString()}{" "}
              {tr("characters")}
            </p>
          </div>
        )}
        {agent.archived && (
          <p className="muted">
            {tr(
              "Saved transcript. Choose Resume in History to continue this conversation.",
            )}
          </p>
        )}
        <ComposerInput
          inputRef={composerInput}
          actionsRef={composerActions}
          configuration={kernel.configuration}
          commands={agent.commands}
          value={agent.draft}
          onChange={(value) => {
            agent.draft = value;
            agent.changed();
          }}
          onSend={() => { void agent.action(() => agent.send()); }}
          onEscape={() => {
            if (!agent.busy || agent.cancelling) return false;
            void agent.action(() => agent.cancel());
            return true;
          }}
          onMention={(mention) => void agent.action(() => agent.attachMention(mention))}
          onImages={(files) => void agent.action(async () => {
            for (const file of files) await agent.attachImage(file);
          })}
          findFiles={(query, signal) => searchFiles(agent.options.filesystem, query, signal)}
        />
        <div className="acp-composer-toolbar">
          <button
            ref={contextTrigger}
            type="button"
            className="icon-button"
            aria-label={tr("Add context")}
            data-tooltip={tr("Add context")}
            aria-controls={contextId}
            aria-expanded={showContext}
            onClick={() => setShowContext(!showContext)}
          >
            <Icon name="plus" />
          </button>
          <IconButton
            icon="diff"
            label="Review changes"
            onClick={() =>
              void agent.action(() => kernel.commands.execute("view.scm"))
            }
          />
          {agent.commands.length > 0 && (
            <button
              type="button"
              className="icon-button acp-slash-button"
              aria-label={tr("Slash commands")}
              data-tooltip={tr("Slash commands")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => composerActions.current?.insertSlash()}
            >
              <span aria-hidden="true">/</span>
            </button>
          )}
          <SendHint configuration={kernel.configuration} />
          {agent.busy && (
            <IconButton
              icon="stop"
              label={agent.cancelling ? "Stopping…" : "Stop"}
              disabled={agent.cancelling}
              onClick={() => void agent.action(() => agent.cancel())}
            />
          )}
          {agent.busy && agent.draft.trim() && <button type="button" className="button acp-interrupt" disabled={agent.cancelling}
            onClick={() => void agent.action(() => agent.interruptAndSend())}>{tr("Interrupt & send")}</button>}
          <IconButton
              icon="arrowUp"
              label={agent.busy ? "Queue message" : "Send"}
              className="icon-button acp-send"
              type="submit"
              disabled={
                (!!connection && !connection.sessionId) ||
                !agent.draft.trim() ||
                !enabled ||
                agent.connecting ||
                agent.updatingSettings ||
                agent.discovering ||
                agent.archived
              }
            />
        </div>
      </form>
      <div className="acp-footer">
        {agent.usage && <ContextMeter usage={agent.usage} />}
        {connection ? (
          <div className="acp-provider" title={agent.displayName}>
            <Icon name="agent" size={14} />
            <span>{agent.displayName}</span>
          </div>
        ) : (agent.messages.length > 0 || agent.archived) && (
          <Select
            label={tr("ACP provider")}
            icon="agent"
            value={chosen}
            options={[
              ...ACP_PROVIDERS.map((p) => ({ value: p.id, label: p.name })),
              ...(acpPreset(chosen) ? [] : [{ value: chosen, label: agent.displayName }]),
              { value: "#registry", label: tr("More agents…") },
              { value: "#custom", label: tr("Custom agent…") },
            ]}
            disabled={agent.connecting}
            onChange={(value) => {
              if (value === "#registry") setChooser("registry");
              else if (value === "#custom") setChooser("custom");
              else void agent.action(() => agent.select({ provider: value }));
            }}
          />
        )}
        {controls.length > 0 && (
          <details className="acp-session-options">
            <summary>
              {tr("Session settings")}
              <Icon name="chevD" size={12} />
            </summary>
            <div className="acp-settings" aria-busy={agent.updatingSettings}>
              {controls.map((control) => (
                <div
                  className="acp-setting"
                  key={`${control.method}:${control.id}`}
                >
                  <span
                    className="acp-setting-label"
                    title={control.description}
                  >
                    {tr(control.name)}
                  </span>
                  <Select
                    label={tr(control.name)}
                    value={control.value}
                    options={control.options}
                    disabled={settingsDisabled}
                    onChange={(value) => {
                      settingsFocus.current =
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null;
                      void agent.action(() =>
                        agent.setSessionControl(control, value),
                      );
                    }}
                  />
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
function AgentStatusItem({ agent }: { agent: AgentController }) {
  useSyncExternalStore(agent.subscribe, agent.snapshot);
  if (!agent.connection) return null;
  const [state, label] = agent.requests.length
    ? ["attention", "Agent needs input"]
    : agent.busy
      ? ["working", "Agent working"]
      : ["ready", "Agent ready"];
  return (
    <button
      type="button"
      className="acp-status-item"
      data-state={state}
      title={tr("Open Agent")}
      onClick={() => void agent.options.kernel.commands.execute("agentACP.open")}
    >
      <Icon name="agentChat" size={13} />
      <span>{tr(label)}</span>
    </button>
  );
}
export function createFeature(options: FeatureOptions): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.agent-acp",
      name: "Agent ACP",
      version: "1.0.0",
      sdk: "^1.0.0",
      description:
        "Codex, Claude Agent, Gemini CLI, GitHub Copilot, Cursor, Amp, and ACP Registry agents with conversations, editor context, tool activity, and approvals.",
      enabledByDefault: false,
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [
        "extensions",
        "filesystem.read",
        "filesystem.write",
        "terminal",
      ],
      configuration: agentConfiguration,
    },
    activate(ctx) {
      const agent = new AgentController(options);
      ctx.own(agent);
      ctx.own(watchThreads(agent, () => options.workbench.panelVisible?.(AGENT_VIEW) === true));
      ctx.own(ctx.services.register("agentACP", agent));
      ctx.own(
        ctx.contributions.register({
          id: AGENT_VIEW,
          kind: "activityView",
          title: "Agent ACP",
          order: 45,
          data: { icon: "agentChat", dock: "right", phoneBar: true, phoneLabel: "Agent" },
          component: () => <AgentPanel agent={agent} />,
        }),
      );
      ctx.own(
        ctx.contributions.register({
          id: "agent-acp-agents",
          kind: "activityView",
          title: "Agents",
          order: 46,
          data: { icon: "agent", dock: "right" },
          component: () => (
            <Subagents
              agent={agent}
              renderRequest={(request) => (
                <RequestCard
                  key={request.requestId}
                  request={request}
                  agent={agent}
                />
              )}
            />
          ),
        }),
      );
      ctx.own(
        ctx.contributions.register({
          id: "agent-acp.status",
          kind: "statusItem",
          title: "Agent status",
          component: () => <AgentStatusItem agent={agent} />,
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "agentACP.openAgents",
          title: "Open Agents",
          category: "Agent ACP",
          run: () => agent.openAgents(),
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "agentACP.open",
          title: "Open Agent ACP",
          category: "Agent ACP",
          run: () => {
            options.workbench.openPanel(AGENT_VIEW);
            agent.markSeen();
          },
        }),
      );
      for (const [id, title, run] of [
        ["agentACP.attachFile", "Attach Active File", () => agent.attach()],
        [
          "agentACP.attachSelection",
          "Attach Selection",
          () => agent.attach(true),
        ],
        ["agentACP.stop", "Stop Agent", () => agent.cancel()],
      ] as const)
        ctx.own(
          ctx.commands.register({
            id,
            title,
            category: "Agent ACP",
            run: async () => {
              await options.kernel.commands.execute("agentACP.open");
              await agent.action(run);
            },
          }),
        );
    },
  };
}
