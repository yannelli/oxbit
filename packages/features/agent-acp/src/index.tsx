import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ACP_PROVIDERS,
  type ACPProviderId,
  type Extension,
  type FeatureOptions,
} from "@oxbit/sdk";
import { Icon, IconButton, Select, translate as tr } from "@oxbit/ui";
import {
  AgentController,
  providerFor,
  type AgentRequest,
} from "./controller.js";
import { sessionControls } from "./session-controls.js";
import { ComposerInput } from "./composer-input.js";
import {
  ActivityFeed,
  FilePatch,
  ConversationBrowser,
  ContextPicker,
  ContextItem,
  ChangeSummary,
} from "./views.js";

import { Subagents } from "./subagents.js";
import { agentConfiguration, settingId } from "./configuration.js";
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
          {params.toolCall?.content?.map((item: any, index: number) => (
            <pre key={index}>
              {item.content?.text ??
                (item.type === "diff" ? `${item.path}\n${item.newText}` : "")}
            </pre>
          ))}
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
  const [provider, setProvider] = useState<ACPProviderId>(
    kernel.configuration.get<ACPProviderId>("agentACP.provider") ?? "codex",
  );
  const preset = providerFor(provider);
  const [command, setCommand] = useState(
    kernel.configuration.get<string>(settingId(provider, "command")) ||
      preset.command,
  );
  const [args, setArgs] = useState(
    kernel.configuration.get<string>(settingId(provider, "args")) ||
      JSON.stringify(preset.args),
  );
  const [showSetup, setShowSetup] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [following, setFollowing] = useState(true);
  const contextId = useId();
  const composerInput = useRef<HTMLTextAreaElement>(null);
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
    if (follow.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [agent.snapshot()]);
  const choose = (value: string) => {
    const next = providerFor(value);
    setProvider(next.id);
    setCommand(
      kernel.configuration.get<string>(settingId(next.id, "command")) ||
        next.command,
    );
    setArgs(
      kernel.configuration.get<string>(settingId(next.id, "args")) ||
        JSON.stringify(next.args),
    );
  };
  const connect = () =>
    agent.action(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(args);
      } catch {
        throw new Error('Arguments must be a JSON array, such as ["acp"]');
      }
      if (
        !Array.isArray(parsed) ||
        parsed.some((arg) => typeof arg !== "string")
      )
        throw new Error("Arguments must be a JSON array of strings");
      await kernel.configuration.set("agentACP.provider", provider, "user");
      await kernel.configuration.set(
        settingId(provider, "command"),
        command,
        "user",
      );
      await kernel.configuration.set(settingId(provider, "args"), args, "user");
      await agent.connect({ provider, command, args: parsed });
    });
  return (
    <div className="acp-panel">
      <div className="acp-header">
        <div className="acp-thread-heading">
          <strong title={agent.title}>{tr(agent.title)}</strong>
          <div className="acp-status" role="status" title={tr(agent.status)}>
            <span className={agent.busy ? "acp-dot working" : "acp-dot"} />
            <span>{tr(agent.status)}</span>
          </div>
          <IconButton
            icon="agent"
            label="Open Agents"
            onClick={() => agent.openAgents()}
          />
          <IconButton
            icon="clock"
            label="History"
            aria-expanded={showHistory}
            onClick={() => setShowHistory(!showHistory)}
          />
          {connection?.sessionId && (
            <IconButton
              icon="plus"
              label="New conversation"
              disabled={
                agent.busy ||
                agent.connecting ||
                agent.updatingSettings ||
                agent.discovering ||
                agent.activeSubagentCount > 0
              }
              onClick={() => void agent.action(() => agent.newSession())}
            />
          )}
          {connection ? (
            <IconButton
              icon="power"
              label="Disconnect"
              disabled={!enabled}
              onClick={() => void agent.action(() => agent.disconnect())}
            />
          ) : (
            <button
              className="button acp-connect"
              disabled={!enabled || agent.connecting}
              onClick={() => void connect()}
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
          <IconButton
            icon="gear"
            label="Setup"
            aria-expanded={showSetup}
            onClick={() => setShowSetup(!showSetup)}
          />
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
        {showSetup && (
          <div className="acp-setup">
            <p>
              {tr(preset.setup)}{" "}
              <a href={preset.url} target="_blank" rel="noreferrer">
                {tr("Setup guide")}
              </a>
            </p>
            <label>
              {tr("Executable")}
              <input
                aria-label={tr("Agent executable")}
                value={command}
                disabled={!!connection || agent.connecting}
                onChange={(event) => setCommand(event.target.value)}
              />
            </label>
            <label>
              {tr("Arguments (JSON array)")}
              <input
                aria-label={tr("Agent arguments")}
                value={args}
                disabled={!!connection || agent.connecting}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
            <p className="muted">
              {tr(
                "Connecting may download the adapter. Agents run with the trusted runtime's privileges and use its existing credentials.",
              )}
            </p>
          </div>
        )}
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
        {!agent.messages.length && (
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
      <form
        className="acp-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void agent.action(() => agent.send());
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
                  label={tr("Remove attachment {0}", { 0: context.path })}
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
          commands={agent.commands}
          value={agent.draft}
          onChange={(value) => {
            agent.draft = value;
            agent.changed();
          }}
          onSend={() => { void agent.action(() => agent.send()); }}
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
            <Select
              label={tr("Agent slash commands")}
              value=""
              options={[
                { value: "", label: tr("Slash commands") },
                ...agent.commands.map((command) => ({
                  value: command.name,
                  label: "/" + command.name,
                })),
              ]}
              onChange={(command) => {
                if (command) {
                  agent.draft = "/" + command + " ";
                  agent.changed();
                  composerInput.current?.focus();
                }
              }}
            />
          )}
          <span className="muted acp-hint">{tr("Ctrl/Cmd+Enter to send")}</span>
          {agent.busy ? (
            <IconButton
              icon="stop"
              label={agent.cancelling ? "Stopping…" : "Stop"}
              disabled={agent.cancelling}
              onClick={() => void agent.action(() => agent.cancel())}
            />
          ) : (
            <IconButton
              icon="arrowUp"
              label="Send"
              className="icon-button acp-send"
              type="submit"
              disabled={
                !connection?.sessionId ||
                !agent.draft.trim() ||
                !enabled ||
                settingsDisabled
              }
            />
          )}
        </div>
      </form>
      <div className="acp-footer">
        {connection ? (
          <div
            className="acp-provider"
            title={providerFor(connection.provider).name}
          >
            <Icon name="agent" size={14} />
            <span>{providerFor(connection.provider).name}</span>
          </div>
        ) : (
          <Select
            label={tr("ACP provider")}
            icon="agent"
            value={provider}
            options={ACP_PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
            disabled={agent.connecting}
            onChange={choose}
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
export function createFeature(options: FeatureOptions): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.agent-acp",
      name: "Agent ACP",
      version: "1.0.0",
      sdk: "^1.0.0",
      description:
        "Codex ACP, Cursor ACP, and Amp Agent ACP with conversations, editor context, tool activity, and approvals.",
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
      ctx.own(ctx.services.register("agentACP", agent));
      ctx.own(
        ctx.contributions.register({
          id: "agent-acp",
          kind: "activityView",
          title: "Agent ACP",
          order: 45,
          data: { icon: "agentChat" },
          component: () => <AgentPanel agent={agent} />,
        }),
      );
      ctx.own(
        ctx.contributions.register({
          id: "agent-acp-agents",
          kind: "activityView",
          title: "Agents",
          order: 46,
          data: { icon: "agent" },
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
          run: () => options.workbench.openPanel("agent-acp"),
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
