import React, { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, Icon, IconButton, Select } from "@oxbit/ui";
import {
  taskPhases,
  type ConfiguredTask,
  type FeatureOptions,
  type TaskCatalog,
  type TaskDefinition,
  type TaskHooks,
  type TaskSource,
  type TaskWorktree,
} from "@oxbit/sdk";
import type { Task } from "./index.js";
export interface TaskModel {
  options: FeatureOptions;
  tasks: Map<string, Task>;
  channels: Map<string, string>;
  catalog?: TaskCatalog;
  worktrees: TaskWorktree[];
  selected?: string;
  error: string;
  loading: boolean;
  select(id: string): void;
  subscribe(listener: () => void): () => void;
  request<T = any>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  refresh(): Promise<void>;
  run(command?: string): Promise<string | undefined>;
  start(id: string): Promise<string>;
  stop(id: string, force?: boolean): Promise<void>;
  restart(id: string): Promise<void>;
  report(action: () => Promise<unknown>): Promise<void>;
}
const cleanDefinition = (task: ConfiguredTask): TaskDefinition => {
  const {
    id: _id,
    name: _name,
    sourceId: _source,
    sourceCommand: _command,
    disabledReason: _reason,
    ...value
  } = task;
  return value;
};
const sourceLabel = (source?: TaskSource) =>
  source
    ? source.private
      ? "Private Oxbit tasks"
      : source.path.split(/[\\/]/).slice(-2).join("/")
    : "";
const stripAnsi = (text: string) =>
  text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const urlPattern = /(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])/g;
export function createTaskViews(model: TaskModel) {
  const o = model.options;
  function useModel() {
    const [, render] = useState(0);
    useEffect(() => model.subscribe(() => render((value) => value + 1)), []);
  }
  function Linkified({ line }: { line: string }) {
    const parts = line.split(urlPattern);
    return (
      <>
        {parts.map((part, index) =>
          index % 2 ? (
            <a
              key={index}
              className="task-url-link"
              href={part}
              onClick={(event) => {
                event.preventDefault();
                window.open(part, "_blank", "noopener,noreferrer");
              }}
            >
              {part}
            </a>
          ) : (
            part
          ),
        )}
      </>
    );
  }
  function Lines({ text }: { text: string }) {
    const lines = stripAnsi(text).split("\n").slice(-3000);
    return (
      <pre className="task-output-text">
        {lines.map((line, index) => {
          const match = line.match(
            /(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.[\w]+):(\d+)(?::(\d+))?/,
          );
          return match && !urlPattern.test(line) ? (
            <button
              key={index}
              className="task-file-link"
              onClick={() =>
                void o.workbench.openFile(match[1], {
                  line: Number(match[2]),
                  col: Number(match[3] ?? 1),
                })
              }
            >
              {line}
              {"\n"}
            </button>
          ) : (
            <React.Fragment key={index}>
              <Linkified line={line} />
              {"\n"}
            </React.Fragment>
          );
        })}
      </pre>
    );
  }
  function TaskEditor({
    task,
    copy = false,
    onClose,
  }: {
    task?: ConfiguredTask;
    copy?: boolean;
    onClose: () => void;
  }) {
    const catalog = useRef(model.catalog!).current;
    const initial = task
      ? cleanDefinition(task)
      : { command: "", type: "command" as const };
    const { command: _command, type: _type, cwd: _cwd, ...extra } = initial;
    const [name, setName] = useState(
      task ? task.name + (copy ? " copy" : "") : "",
    );
    const [sourceId, setSource] = useState(
      copy
        ? (catalog.sources.find((s) => s.kind === "oxbit" && !s.private)?.id ??
            catalog.sources.find((s) => s.private)!.id)
        : (task?.sourceId ?? catalog.defaultSourceId),
    );
    const [command, setCommand] = useState(
      copy ? initial.command : (task?.sourceCommand ?? initial.command),
    );
    const [type, setType] = useState(initial.type ?? "command"),
      [cwd, setCwd] = useState(initial.cwd ?? "");
    const [advanced, setAdvanced] = useState(JSON.stringify(extra, null, 2));
    const [error, setError] = useState(""),
      [busy, setBusy] = useState(false);
    const source = catalog.sources.find((s) => s.id === sourceId)!;
    const submit = async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        const settings = JSON.parse(advanced);
        if (
          !settings ||
          typeof settings !== "object" ||
          Array.isArray(settings)
        )
          throw new Error("Advanced settings must be a JSON object");
        const packageSource =
          source.kind === "npm" || source.kind === "composer";
        const definition: TaskDefinition = {
          ...settings,
          command: packageSource && task && !copy ? initial.command : command,
          type,
          ...(cwd.trim() ? { cwd } : {}),
        };
        await model.request("tasks.save", {
          sourceId,
          name,
          task: definition,
          ...(packageSource ? { sourceCommand: command } : {}),
          expectedRevision: source.revision,
          create: !task || copy,
        });
        await model.refresh();
        onClose();
      } catch (failure) {
        setError((failure as Error).message);
      } finally {
        setBusy(false);
      }
    };
    return (
      <Dialog
        title={task && !copy ? "Edit task" : "New task"}
        className="task-dialog"
        initialFocus={task && !copy ? ".task-command" : ".task-name"}
        onClose={onClose}
      >
        <form onSubmit={(event) => void submit(event)}>
          <div className="task-form-grid">
            <label>
              Task name
              <input
                className="task-name"
                value={name}
                required
                maxLength={120}
                disabled={!!task && !copy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Kind
              <Select
                label="Task kind"
                value={type}
                options={[
                  { value: "command", label: "Command · runs to completion" },
                  { value: "service", label: "Service · stays running" },
                ]}
                onChange={(value) => setType(value as "command" | "service")}
              />
            </label>
          </div>
          <label>
            Save to
            <Select
              label="Task source"
              value={sourceId}
              disabled={!!task && !copy}
              options={catalog.sources
                .filter((s) => s.writable)
                .map((s) => ({ value: s.id, label: sourceLabel(s) }))}
              onChange={setSource}
            />
          </label>
          <p className="task-hint task-source-path">{source.path}</p>
          <label>
            {source.kind === "npm" || source.kind === "composer"
              ? "Script body"
              : "Command"}
            <textarea
              className="task-command"
              value={command}
              required={!advanced.includes('"dependsOn"')}
              rows={3}
              spellCheck={false}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={
                'npm run dev -- --host "$OXBIT_HOST" --port "$OXBIT_PORT"'
              }
            />
          </label>
          <label>
            Working directory
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="$OXBIT_PROJECT_DIR"
            />
          </label>
          <p className="task-hint">
            Commands receive <code>$OXBIT_PROJECT_DIR</code>,{" "}
            <code>$OXBIT_PREINIT_DIR</code>, <code>$OXBIT_HOST</code> and{" "}
            <code>$OXBIT_HOSTNAME</code>. Services also receive{" "}
            <code>$OXBIT_PORT</code>, <code>$OXBIT_URL</code> and peer-service
            variables.
          </p>
          <details open={!!task || type === "service"}>
            <summary>Environment, dependencies and service settings</summary>
            <p className="task-hint">
              Set <code>env</code>, <code>dependsOn</code>, <code>port</code>{" "}
              (number, "auto", or range), <code>ports</code>, <code>ready</code>
              , <code>restart</code>, and <code>stop</code>.
            </p>
            <textarea
              aria-label="Advanced task settings"
              className="task-json"
              value={advanced}
              rows={8}
              spellCheck={false}
              onChange={(e) => setAdvanced(e.target.value)}
            />
            <button
              type="button"
              className="button"
              onClick={() => {
                try {
                  setAdvanced(
                    JSON.stringify(
                      {
                        ...JSON.parse(advanced || "{}"),
                        port: "auto",
                        ready: {
                          url: "http://$OXBIT_HOST:$OXBIT_PORT/",
                          timeoutMs: 30000,
                        },
                        stop: { timeoutMs: 5000 },
                        restart: { policy: "on-failure", maxAttempts: 3 },
                      },
                      null,
                      2,
                    ),
                  );
                  setError("");
                } catch {
                  setError(
                    "Fix the advanced JSON before applying service settings",
                  );
                }
              }}
            >
              Use service settings
            </button>
          </details>
          {task?.disabledReason && (
            <p className="task-hint">{task.disabledReason}</p>
          )}
          {error && (
            <p role="alert" className="task-error">
              {error}
            </p>
          )}
          <div className="task-dialog-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save task"}
            </button>
          </div>
        </form>
      </Dialog>
    );
  }
  function SettingsEditor({ onClose }: { onClose: () => void }) {
    const catalog = useRef(model.catalog!).current;
    const selected = catalog.sources.find(
      (s) => s.id === catalog.defaultSourceId,
    )!;
    const source = ["procfile", "make", "just"].includes(selected.kind)
      ? catalog.sources.find((s) => s.private)!
      : selected;
    const [scripts, setScripts] = useState<TaskHooks>(catalog.worktree),
      [env, setEnv] = useState(JSON.stringify(catalog.env, null, 2));
    const [error, setError] = useState(""),
      [busy, setBusy] = useState(false);
    const submit = async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError("");
      try {
        await model.request("tasks.settings", {
          sourceId: source.id,
          worktree: scripts,
          env: JSON.parse(env),
          expectedRevision: source.revision,
        });
        await model.refresh();
        onClose();
      } catch (failure) {
        setError((failure as Error).message);
      } finally {
        setBusy(false);
      }
    };
    return (
      <Dialog
        title="Worktree lifecycle and environment"
        className="task-dialog"
        initialFocus="textarea"
        onClose={onClose}
      >
        <form onSubmit={(event) => void submit(event)}>
          <p className="task-hint task-source-path">Saving to {source.path}</p>
          <p className="task-hint">
            Hooks run only during explicit Oxbit worktree operations. Each phase
            stops on failure. <code>$OXBIT_PROJECT_DIR</code> is the target
            checkout, <code>$OXBIT_SOURCE_DIR</code> is the source, and{" "}
            <code>$OXBIT_PREINIT_DIR</code> is the private staging directory.
          </p>
          {taskPhases.map((phase) => (
            <label key={phase}>
              {phase}
              <small>
                {
                  {
                    preinit:
                      "Before checkout creation · working directory: staging",
                    init: "After checkout creation · working directory: checkout",
                    preteardown:
                      "Before checkout removal · working directory: checkout",
                    teardown:
                      "After checkout removal · working directory: staging",
                  }[phase]
                }
              </small>
              <textarea
                aria-label={`${phase} script`}
                value={
                  Array.isArray(scripts[phase])
                    ? scripts[phase].join("\n")
                    : (scripts[phase] ?? "")
                }
                rows={3}
                spellCheck={false}
                onChange={(e) =>
                  setScripts((previous) => ({
                    ...previous,
                    [phase]: e.target.value,
                  }))
                }
              />
            </label>
          ))}
          <label>
            Shared environment (JSON)
            <textarea
              aria-label="Shared task environment"
              value={env}
              rows={4}
              spellCheck={false}
              onChange={(e) => setEnv(e.target.value)}
            />
          </label>
          {error && (
            <p className="task-error" role="alert">
              {error}
            </p>
          )}
          <div className="task-dialog-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? "Saving…" : "Save lifecycle"}
            </button>
          </div>
        </form>
      </Dialog>
    );
  }
  function Panel() {
    useModel();
    const [tab, setTab] = useState<"tasks" | "worktrees">("tasks"),
      [query, setQuery] = useState("");
    const [editor, setEditor] = useState<{
        task?: ConfiguredTask;
        copy?: boolean;
      }>(),
      [settings, setSettings] = useState(false),
      [busy, setBusy] = useState(false);
    const closeEditor = useCallback(() => setEditor(undefined), []),
      closeSettings = useCallback(() => setSettings(false), []);
    const catalog = model.catalog,
      runs = [...model.tasks.values()].reverse(),
      connected = !!o.runtime?.connected;
    const selectedRun = model.tasks.get(model.selected ?? ""),
      selectedTask = catalog?.tasks.find(
        (task) => task.id === (selectedRun?.taskId ?? model.selected),
      );
    const source = catalog?.sources.find(
      (source) => source.id === selectedTask?.sourceId,
    );
    useEffect(() => {
      void model.refresh();
    }, []);
    const perform = (action: () => Promise<unknown>) => {
      void model.report(action);
    };
    const share = async () => {
      if (!catalog) return;
      const answer = await o.workbench.ask(
        "Save tasks in project",
        "Create .oxbit/tasks.json with the currently detected, supported tasks and lifecycle scripts? This makes the configuration available to version control.",
        ["Save in project", "Cancel"],
      );
      if (answer !== "Save in project") return;
      const result = await model.request("tasks.share", {
        expectedRevisions: Object.fromEntries(
          catalog.sources.map((source) => [source.id, source.revision]),
        ),
      });
      await model.refresh();
      o.workbench.notify(
        result.skipped.length
          ? `Saved .oxbit/tasks.json. ${result.skipped.length} unsupported IDE configurations were left in their source files.`
          : "Saved .oxbit/tasks.json. Review it in Source Control to commit.",
      );
    };
    const removeTask = async () => {
      if (!selectedTask || !source) return;
      if (
        (await o.workbench.ask(
          "Delete task",
          `Remove ${selectedTask.name} from ${source.path}?`,
          ["Delete task", "Cancel"],
          true,
        )) !== "Delete task"
      )
        return;
      await model.request("tasks.save", {
        sourceId: source.id,
        name: selectedTask.name,
        expectedRevision: source.revision,
      });
      await model.refresh();
    };
    const createWorktree = async () => {
      const branch = await o.workbench.prompt("New worktree branch");
      if (!branch) return;
      const base = await o.workbench.prompt(
        "Create worktree from revision",
        "HEAD",
      );
      if (!base) return;
      setBusy(true);
      try {
        await model.request("tasks.worktreeCreate", { branch, base });
      } finally {
        setBusy(false);
        await model.refresh();
      }
    };
    const removeWorktree = async (worktree: TaskWorktree) => {
      if (
        (await o.workbench.ask(
          "Remove worktree",
          `Run cleanup hooks and remove ${worktree.path}? Git will refuse removal if it has uncommitted or untracked files. The branch remains.`,
          ["Remove worktree", "Cancel"],
          true,
        )) !== "Remove worktree"
      )
        return;
      setBusy(true);
      try {
        await model.request("tasks.worktreeRemove", { id: worktree.id });
      } finally {
        setBusy(false);
        await model.refresh();
      }
    };
    return (
      <div className="tasks-panel">
        <div className="tasks-toolbar">
          <div className="tasks-tabs" role="tablist" aria-label="Task views">
            {(["tasks", "worktrees"] as const).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
              >
                {value === "tasks" ? "Tasks & services" : "Worktrees"}
              </button>
            ))}
          </div>
          <span className="tasks-toolbar-spacer" />
          <button
            className="button"
            disabled={!catalog}
            onClick={() => setEditor({})}
          >
            <Icon name="plus" size={13} />
            New task
          </button>
          <button
            className="button"
            disabled={!connected}
            onClick={() => perform(() => model.run())}
          >
            Run command
          </button>
          <IconButton
            icon="settings"
            label="Worktree lifecycle and environment"
            disabled={!catalog}
            onClick={() => setSettings(true)}
          />
          <IconButton
            icon="refresh"
            label="Refresh tasks"
            disabled={!connected || model.loading}
            onClick={() => perform(model.refresh)}
          />
        </div>
        {model.error && (
          <p className="task-error tasks-banner" role="alert">
            {model.error}
          </p>
        )}
        {!connected && (
          <div className="tasks-empty">
            <Icon name="terminal" size={28} />
            <strong>Connect a workspace to run tasks</strong>
            <p>
              Detected commands, services and their output will appear here.
            </p>
          </div>
        )}
        {connected && tab === "tasks" && (
          <div className="tasks-layout">
            <aside
              className="tasks-list"
              aria-label="Configured tasks and runs"
            >
              <input
                className="tasks-search"
                type="search"
                aria-label="Filter tasks"
                placeholder="Filter tasks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="tasks-list-heading">
                Configured <span>{catalog?.tasks.length ?? 0}</span>
              </div>
              {catalog?.tasks
                .filter((task) =>
                  task.name.toLowerCase().includes(query.toLowerCase()),
                )
                .map((task) => {
                  const active = runs.find(
                      (run) =>
                        run.taskId === task.id && run.exitCode === undefined,
                    ),
                    origin = catalog.sources.find(
                      (s) => s.id === task.sourceId,
                    );
                  return (
                    <div
                      className={`task-list-row ${model.selected === task.id ? "selected" : ""}`}
                      key={task.id}
                    >
                      <button
                        className="task-row-main"
                        onClick={() => model.select(task.id)}
                        title={task.disabledReason ?? task.command}
                      >
                        <Icon
                          name={
                            task.type === "service"
                              ? "languageServer"
                              : "terminal"
                          }
                          size={14}
                        />
                        <span>
                          <strong>{task.name}</strong>
                          <small>
                            {active?.state ??
                              (task.disabledReason
                                ? "Needs configuration"
                                : sourceLabel(origin))}
                          </small>
                        </span>
                      </button>
                      <IconButton
                        icon={active ? "stop" : "play"}
                        label={`${active ? "Stop" : "Start"} ${task.name}`}
                        disabled={!!task.disabledReason}
                        onClick={() =>
                          perform(() =>
                            active
                              ? model.stop(active.id)
                              : model.start(task.id),
                          )
                        }
                      />
                    </div>
                  );
                })}
              {catalog && !catalog.tasks.length && (
                <p className="task-hint tasks-list-empty">
                  No tasks detected. Add a command or service; it will save
                  privately by default.
                </p>
              )}
              {!!runs.length && (
                <div className="tasks-list-heading">
                  Recent runs <span>{runs.length}</span>
                </div>
              )}
              {runs
                .filter((run) =>
                  (run.name ?? run.command)
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .slice(0, 64)
                .map((run) => (
                  <button
                    key={run.id}
                    className={`task-run-row ${model.selected === run.id ? "selected" : ""}`}
                    onClick={() => model.select(run.id)}
                  >
                    <span className="task-state-dot" data-state={run.state} />
                    <span>
                      <strong>{run.name ?? run.command}</strong>
                      <small>
                        {run.state}
                        {run.exitCode === undefined
                          ? ""
                          : ` · exit ${run.exitCode}`}
                      </small>
                    </span>
                  </button>
                ))}
            </aside>
            <section className="tasks-detail" aria-label="Task details">
              {selectedRun ? (
                <>
                  <div className="task-detail-header">
                    <div>
                      <strong>{selectedRun.name ?? selectedRun.command}</strong>
                      <span
                        className="task-state"
                        data-state={selectedRun.state}
                      >
                        {selectedRun.state}
                      </span>
                    </div>
                    <div className="task-detail-actions">
                      {selectedRun.exitCode === undefined ? (
                        <>
                          <button
                            className="button"
                            onClick={() =>
                              perform(() => model.stop(selectedRun.id))
                            }
                          >
                            Stop
                          </button>
                          <button
                            className="button danger"
                            onClick={() =>
                              perform(() => model.stop(selectedRun.id, true))
                            }
                          >
                            Force stop
                          </button>
                        </>
                      ) : (
                        <button
                          className="button"
                          onClick={() =>
                            perform(() => model.restart(selectedRun.id))
                          }
                        >
                          Run again
                        </button>
                      )}
                      <button
                        className="button"
                        onClick={() =>
                          perform(() => model.restart(selectedRun.id))
                        }
                      >
                        Restart
                      </button>
                    </div>
                  </div>
                  <div className="task-run-meta">
                    <code>{selectedRun.command}</code>
                    <small>
                      {selectedRun.cwd}
                      {selectedRun.pid ? ` · PID ${selectedRun.pid}` : ""}
                      {selectedRun.restarts
                        ? ` · ${selectedRun.restarts} restarts`
                        : ""}
                    </small>
                    {selectedRun.message && (
                      <p role="status">{selectedRun.message}</p>
                    )}
                  </div>
                  {!!selectedRun.links?.length && (
                    <nav
                      className="task-links"
                      aria-label="Detected task links"
                    >
                      {selectedRun.links.map((link) => (
                        <a
                          key={link}
                          href={link}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Icon name="goto" size={12} />
                          {link}
                        </a>
                      ))}
                    </nav>
                  )}
                  {selectedRun.variables && (
                    <details className="task-variables">
                      <summary>Assigned variables</summary>
                      <dl>
                        {Object.entries(selectedRun.variables).map(
                          ([key, value]) => (
                            <React.Fragment key={key}>
                              <dt>{key}</dt>
                              <dd>{value}</dd>
                            </React.Fragment>
                          ),
                        )}
                      </dl>
                    </details>
                  )}
                  {selectedRun.truncated && (
                    <p className="task-hint">
                      Earlier task output is no longer available.
                    </p>
                  )}
                  <div className="task-log" aria-label="Task output">
                    <Lines text={selectedRun.output} />
                  </div>
                </>
              ) : selectedTask ? (
                <>
                  <div className="task-detail-header">
                    <div>
                      <strong>{selectedTask.name}</strong>
                      <span className="task-state">
                        {selectedTask.type ?? "command"}
                      </span>
                    </div>
                    <div className="task-detail-actions">
                      <button
                        className="button primary"
                        disabled={!!selectedTask.disabledReason}
                        onClick={() =>
                          perform(() => model.start(selectedTask.id))
                        }
                      >
                        Start
                      </button>
                      <button
                        className="button"
                        disabled={!source?.writable}
                        onClick={() => setEditor({ task: selectedTask })}
                      >
                        Edit
                      </button>
                      <button
                        className="button"
                        onClick={() =>
                          setEditor({ task: selectedTask, copy: true })
                        }
                      >
                        Copy to Oxbit
                      </button>
                      <IconButton
                        icon="trash"
                        label="Delete task"
                        disabled={!source?.writable}
                        onClick={() => perform(removeTask)}
                      />
                    </div>
                  </div>
                  <p className="task-source-path task-hint">{source?.path}</p>
                  {selectedTask.disabledReason && (
                    <p className="task-error">{selectedTask.disabledReason}</p>
                  )}
                  <pre className="task-definition">
                    {JSON.stringify(cleanDefinition(selectedTask), null, 2)}
                  </pre>
                </>
              ) : (
                <div className="tasks-empty">
                  <Icon name="terminal" size={28} />
                  <strong>Commands and services, ready to run</strong>
                  <p>
                    Select a task to inspect it, or start one to follow its
                    output and detected links.
                  </p>
                  {catalog && (
                    <>
                      <small>
                        New tasks save to{" "}
                        {sourceLabel(
                          catalog.sources.find(
                            (s) => s.id === catalog.defaultSourceId,
                          ),
                        )}
                        .
                      </small>
                      <button className="button" onClick={() => perform(share)}>
                        Save in project…
                      </button>
                    </>
                  )}
                </div>
              )}
              {!!catalog?.sources.some(
                (source) => source.diagnostics.length,
              ) && (
                <details className="task-import-notes">
                  <summary>Import notes</summary>
                  {catalog.sources.flatMap((source) =>
                    source.diagnostics.map((note, index) => (
                      <p key={source.id + index}>
                        <strong>{sourceLabel(source)}:</strong> {note}
                      </p>
                    )),
                  )}
                </details>
              )}
            </section>
          </div>
        )}
        {connected && tab === "worktrees" && (
          <section className="tasks-worktrees" aria-label="Managed worktrees">
            <div className="task-detail-header">
              <div>
                <strong>Managed worktrees</strong>
                <p className="task-hint">
                  Create an isolated checkout with your lifecycle scripts.
                </p>
              </div>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => perform(createWorktree)}
              >
                {busy ? "Working…" : "Create worktree"}
              </button>
            </div>
            {model.worktrees.map((worktree) => (
              <article className="task-worktree" key={worktree.id}>
                <strong>{worktree.branch}</strong>
                <span className="task-state">{worktree.state}</span>
                <code>{worktree.path}</code>
                {worktree.message && (
                  <p className="task-error">{worktree.message}</p>
                )}
                <div className="task-detail-actions">
                  <button
                    className="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(worktree.path)
                        .catch((error) =>
                          o.workbench.notify(String(error), "error"),
                        );
                    }}
                  >
                    Copy path
                  </button>
                  {worktree.state === "init-failed" && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        perform(async () => {
                          try {
                            await model.request("tasks.worktreeInit", {
                              id: worktree.id,
                            });
                          } finally {
                            await model.refresh();
                          }
                        })
                      }
                    >
                      Retry init
                    </button>
                  )}
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => perform(() => removeWorktree(worktree))}
                  >
                    {worktree.state === "teardown-failed"
                      ? "Retry teardown"
                      : "Remove worktree"}
                  </button>
                </div>
              </article>
            ))}
            {!model.worktrees.length && (
              <p className="task-hint">
                No Oxbit-managed worktrees for this project yet.
              </p>
            )}
          </section>
        )}
        {catalog && (
          <footer className="tasks-footer">
            <span>
              {model.loading
                ? "Refreshing…"
                : `${catalog.tasks.filter((task) => task.type === "service").length} services · ${runs.filter((run) => run.exitCode === undefined).length} active`}
            </span>
            <button onClick={() => perform(share)}>Save in project…</button>
          </footer>
        )}
        {editor && <TaskEditor {...editor} onClose={closeEditor} />}
        {settings && <SettingsEditor onClose={closeSettings} />}
      </div>
    );
  }
  function Output() {
    useModel();
    const [channel, setChannel] = useState("Tasks");
    const [, render] = useState(0);
    useEffect(
      () =>
        o.kernel.contributions.subscribe(() => render((value) => value + 1)),
      [],
    );
    const contributed = o.kernel.contributions.list("outputChannel"),
      names = [
        ...new Set([...model.channels.keys(), ...contributed.map((c) => c.id)]),
      ],
      selected = names.includes(channel) ? channel : "Tasks";
    const data = contributed.find((item) => item.id === selected)?.data as
      { lines?: string[] } | undefined;
    return (
      <div
        className="output-panel"
        style={{ padding: 12, height: "100%", overflow: "auto" }}
      >
        <Select
          label="Output channel"
          value={selected}
          icon="terminal"
          options={names.map((name) => ({ value: name, label: name }))}
          onChange={setChannel}
        />
        <Lines
          text={model.channels.get(selected) ?? data?.lines?.join("\n") ?? ""}
        />
      </div>
    );
  }
  return { Panel, Output };
}
