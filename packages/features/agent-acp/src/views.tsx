import { useEffect, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { createTwoFilesPatch } from "diff";
import { Icon, IconButton, translate as tr } from "@oxbit/ui";
import type { ACPContext } from "@oxbit/sdk";
import { providerFor, type AgentController } from "./controller.js";

const markdown = new MarkdownIt({ html: false, linkify: true });
export function markdownHTML(text: string) {
  return DOMPurify.sanitize(markdown.render(text), {
    FORBID_TAGS: [
      "img",
      "style",
      "script",
      "iframe",
      "video",
      "audio",
      "form",
      "input",
    ],
    FORBID_ATTR: ["style", "srcset"],
    ALLOW_DATA_ATTR: false,
  });
}
export function Markdown({
  text,
  agent,
}: {
  text: string;
  agent: AgentController;
}) {
  const html = useMemo(() => markdownHTML(text), [text]);
  return (
    <div
      className="acp-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute("href") || "";
        if (/^https?:\/\//i.test(href))
          window.open(href, "_blank", "noopener,noreferrer");
        else if (
          !/^[a-z][a-z0-9+.-]*:/i.test(href) &&
          !href.startsWith("//") &&
          !href.startsWith("#")
        ) {
          const match = href.match(/^(.*?)(?:#L(\d+)|:(\d+)(?::\d+)?)?$/);
          if (match)
            void agent.action(() =>
              agent.openLocation(
                decodeURIComponent(match[1]),
                Number(match[2] || match[3] || 1) - 1,
              ),
            );
        }
      }}
    />
  );
}
export function FilePatch({
  before,
  after,
  path,
}: {
  before: string;
  after: string;
  path: string;
}) {
  const patch = useMemo(() => {
    if (before === after) return tr("No changes");
    if (before.length + after.length > 400000) return undefined;
    return createTwoFilesPatch(
      path,
      path,
      before,
      after,
      "Current",
      "Proposed",
      { context: 3, timeout: 50, maxEditLength: 10000 },
    );
  }, [before, after, path]);
  return patch ? (
    <pre className="acp-patch" aria-label={tr("File change diff")} tabIndex={0}>
      {patch.split("\n").map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith("+")
              ? "added"
              : line.startsWith("-")
                ? "removed"
                : line.startsWith("@@")
                  ? "hunk"
                  : ""
          }
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  ) : (
    <div className="acp-large-diff">
      <p>{tr("Large change. Compare the complete snapshots below.")}</p>
      <details>
        <summary>{tr("Current content")}</summary>
        <pre>{before}</pre>
      </details>
      <details>
        <summary>{tr("Proposed content")}</summary>
        <pre>{after}</pre>
      </details>
    </div>
  );
}
export function ContextItem({ item }: { item: ACPContext }) {
  return (
    <details className="acp-context-item">
      <summary>
        {item.label || item.path}{" "}
        <span className="muted">
          {item.text.length.toLocaleString()} {tr("characters")}
        </span>
      </summary>
      <pre>{item.text}</pre>
    </details>
  );
}
function ToolCard({ id, agent }: { id: string; agent: AgentController }) {
  const tool = agent.tools.get(id);
  if (!tool) return null;
  return (
    <details className="acp-card acp-tool" data-status={tool.status}>
      <summary>
        <span>{tool.title || tr("Agent tool")}</span>
        <span className="acp-tool-status">{tr(tool.status ?? "pending")}</span>
      </summary>
      {(tool.locations ?? []).map((location: any, index: number) => (
        <button
          className="button"
          key={index}
          onClick={() =>
            void agent.action(() =>
              agent.openLocation(location.path, location.line),
            )
          }
        >
          {location.path}
        </button>
      ))}
      {(tool.content ?? []).map((item: any, index: number) =>
        item.type === "diff" ? (
          <FilePatch
            key={index}
            path={item.path}
            before={item.oldText ?? ""}
            after={item.newText ?? ""}
          />
        ) : item.type === "terminal" ? (
          <pre key={index}>
            {agent.terminals.get(item.terminalId)?.output ||
              tr("Terminal output is no longer available")}
          </pre>
        ) : (
          <Markdown
            key={index}
            text={item.content?.text || item.content?.resource?.text || ""}
            agent={agent}
          />
        ),
      )}
      {tool.rawInput && (
        <details>
          <summary>{tr("Tool input")}</summary>
          <pre>{JSON.stringify(tool.rawInput, null, 2)}</pre>
        </details>
      )}
      {tool.rawOutput && (
        <details>
          <summary>{tr("Tool output")}</summary>
          <pre>
            {typeof tool.rawOutput === "string"
              ? tool.rawOutput
              : JSON.stringify(tool.rawOutput, null, 2)}
          </pre>
        </details>
      )}
    </details>
  );
}
export function ActivityFeed({ agent }: { agent: AgentController }) {
  const [copied, setCopied] = useState<number>();
  return (
    <div
      role="log"
      aria-label={tr("Agent conversation")}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {agent.activity.map((entry, index) =>
        entry.kind === "tool" ? (
          <ToolCard
            key={`tool:${entry.id}:${index}`}
            id={entry.id}
            agent={agent}
          />
        ) : entry.kind === "subagent" ? (
          agent.subagents.has(entry.id) && (
            <button
              key={`child:${entry.id}`}
              className="button acp-delegation-link"
              onClick={() => agent.openAgents(entry.id)}
            >
              <Icon name="agent" size={14} /> {tr("Delegated")}:{" "}
              {agent.subagents.get(entry.id)!.name}
            </button>
          )
        ) : entry.kind === "notice" ? (
          <p className="acp-turn-note" key={index}>
            {tr(entry.text)}
          </p>
        ) : entry.message.role === "thought" ? (
          <details className="acp-message acp-thinking" key={index}>
            <summary>{tr("Thinking")}</summary>
            <Markdown text={entry.message.text} agent={agent} />
          </details>
        ) : (
          <article className={`acp-message ${entry.message.role}`} key={index}>
            <div className="acp-message-heading">
              {entry.message.role !== "user" && <Icon name="agent" size={16} />}
              <strong>
                {entry.message.role === "user"
                  ? tr("You")
                  : providerFor(
                      agent.connection?.provider ?? agent.launch.provider,
                    ).name}
              </strong>
              <IconButton
                icon={copied === index ? "check" : "copy"}
                label="Copy message"
                title={copied === index ? "Copied" : "Copy message"}
                onClick={() =>
                  void agent.action(async () => {
                    await navigator.clipboard.writeText(entry.message.text);
                    setCopied(index);
                  })
                }
              />
            </div>
            {entry.message.role === "user" ? (
              <p className="acp-user-text">{entry.message.text}</p>
            ) : (
              <Markdown text={entry.message.text} agent={agent} />
            )}
            {entry.message.context?.map((item, i) => (
              <ContextItem key={i} item={item} />
            ))}
          </article>
        ),
      )}
    </div>
  );
}
export function ConversationBrowser({ agent }: { agent: AgentController }) {
  const [search, setSearch] = useState("");
  const disabled =
    agent.busy ||
    agent.connecting ||
    agent.updatingSettings ||
    agent.discovering ||
    agent.activeSubagentCount > 0;
  const entries = agent.history.entries.filter(
    (e) =>
      (!agent.connection || e.root === agent.connection.root) &&
      `${e.title} ${e.provider} ${e.activity.flatMap((a) => (a.kind === "message" ? a.message.text : [])).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <section className="acp-history" aria-label={tr("Conversation history")}>
      <label>
        {tr("Search conversations")}
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {agent.history.error && <p role="alert">{tr(agent.history.error)}</p>}
      {!entries.length && (
        <p className="muted">{tr("No saved conversations yet")}</p>
      )}
      {entries.map((entry) => (
        <article className="acp-history-entry" key={entry.id}>
          <strong>{entry.title}</strong>
          <span className="muted">
            {providerFor(entry.provider).name} ·{" "}
            {new Date(entry.updatedAt).toLocaleString()}
          </span>
          {entry.truncated && (
            <span className="muted">
              {tr("Local preview trimmed; loading restores provider history.")}
            </span>
          )}
          <div className="acp-actions">
            <button
              className="button"
              disabled={disabled}
              onClick={() =>
                void agent.action(() => agent.viewConversation(entry))
              }
            >
              {tr("Read")}
            </button>
            <button
              className="button"
              disabled={disabled || !agent.options.runtime?.connected}
              onClick={() => void agent.action(() => agent.resumeSaved(entry))}
            >
              {tr("Resume")}
            </button>
            <button
              className="button"
              disabled={disabled}
              onClick={() =>
                void agent.action(async () => {
                  const choice = await agent.options.workbench.ask(
                    tr("Forget conversation"),
                    tr(
                      "Remove the local transcript? The provider's session is kept.",
                    ),
                    [tr("Forget"), tr("Cancel")],
                  );
                  if (choice === tr("Forget")) {
                    await agent.forgetConversation(entry.id);
                    agent.changed();
                  }
                })
              }
            >
              {tr("Forget")}
            </button>
          </div>
        </article>
      ))}
      {agent.connection?.capabilities?.sessionCapabilities?.list && (
        <>
          <button
            className="button"
            disabled={disabled}
            onClick={() => void agent.action(() => agent.discover())}
          >
            {tr(agent.discovering ? "Loading…" : "Find provider conversations")}
          </button>
          {agent.sessions
            .filter((s) =>
              (s.title || s.sessionId)
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((session) => (
              <article className="acp-history-entry" key={session.sessionId}>
                <strong>{session.title || session.sessionId}</strong>
                <button
                  className="button"
                  disabled={
                    disabled ||
                    !(
                      agent.connection?.capabilities?.loadSession ||
                      agent.connection?.capabilities?.sessionCapabilities
                        ?.resume
                    )
                  }
                  onClick={() =>
                    void agent.action(() => agent.importConversation(session))
                  }
                >
                  {tr("Open conversation")}
                </button>
              </article>
            ))}
          {agent.nextCursor && (
            <button
              className="button"
              disabled={disabled}
              onClick={() => void agent.action(() => agent.discover(true))}
            >
              {tr("Load more")}
            </button>
          )}
        </>
      )}
    </section>
  );
}
export function ContextPicker({ agent }: { agent: AgentController }) {
  const [folder, setFolder] = useState(""),
    [filter, setFilter] = useState("");
  const [files, setFiles] = useState<
      { path: string; name: string; kind: string }[]
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setFiles([]);
    setError("");
    void agent.options.filesystem.list(folder).then(
      (items) => {
        if (active) setFiles(items);
      },
      (e) => {
        if (active) setError(String(e));
      },
    );
    return () => {
      active = false;
    };
  }, [agent, folder]);
  return (
    <div className="acp-context-picker" aria-label={tr("Choose context")}>
      <label>
        {tr("Filter files")}
        <input value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      {folder && (
        <button
          type="button"
          className="button"
          onClick={() => {
            setFolder(folder.split("/").slice(0, -1).join("/"));
            setFilter("");
          }}
        >
          ← {folder}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="acp-context-files">
        {files
          .filter((f) => f.name.toLowerCase().includes(filter.toLowerCase()))
          .slice(0, 100)
          .map((file) => (
            <button
              key={file.path}
              type="button"
              className="button"
              onClick={() => {
                if (file.kind === "directory") {
                  setFolder(file.path);
                  setFilter("");
                } else void agent.action(() => agent.attachPath(file.path));
              }}
            >
              {file.kind === "directory" ? "▸ " : "+ "}
              {file.name}
            </button>
          ))}
      </div>
    </div>
  );
}
export function ChangeSummary({ agent }: { agent: AgentController }) {
  if (!agent.changes.length) return null;
  return (
    <section className="acp-changes" aria-label={tr("Reviewed agent edits")}>
      <strong>{tr("Reviewed agent edits")}</strong>
      {agent.changes.map((change) => (
        <details key={change.id}>
          <summary>
            {change.path} · {tr(change.undone ? "Undone" : "Applied")}
          </summary>
          <FilePatch
            path={change.path}
            before={change.before}
            after={change.after}
          />
          {!change.undone && !change.created && (
            <button
              className="button"
              disabled={
                agent.busy || agent.connecting || agent.requests.length > 0
              }
              onClick={() =>
                void agent.action(() => agent.undoChange(change.id))
              }
            >
              {tr("Undo this edit")}
            </button>
          )}
        </details>
      ))}
    </section>
  );
}
