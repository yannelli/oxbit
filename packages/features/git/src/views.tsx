import { useEffect, useRef, useState, type DependencyList } from "react";
import type {
  FeatureOptions,
  GitStatus,
  GitLog,
  GitCommit,
  GitCommitDetail,
  GitDiff,
  GitStash,
} from "@oxbit/sdk";
import { Icon, IconButton, Select, translate as tr } from "@oxbit/ui";

export interface RepositoryUI {
  options: FeatureOptions;
  request<T = any>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
  perform(method: string, params?: Record<string, unknown>): Promise<unknown>;
  openCommit(ref: string): void;
  openStash(stash: GitStash): void;
  report(action: () => Promise<unknown>): void;
}
function useQuery<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(undefined);
    void load(controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) setData(value);
        },
        (error) => {
          if (!controller.signal.aborted) setError(String(error));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, deps);
  return { data, error, loading };
}
function Feedback({ error, loading }: { error: string; loading: boolean }) {
  return (
    <>
      {loading && (
        <p className="scm-empty" role="status">
          {tr("Loading…")}
        </p>
      )}
      {error && (
        <p className="scm-feedback error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
export function Patch({ text }: { text: string }) {
  return (
    <pre className="scm-patch" aria-label={tr("Inline diff")}>
      {text.split("\n").map((line, index) => (
        <span
          className="scm-diff-line"
          data-kind={
            line.startsWith("+") && !line.startsWith("+++")
              ? "add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "delete"
                : line.startsWith("@@")
                  ? "hunk"
                  : "context"
          }
          key={index}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}
function CommitRow({
  commit,
  onClick,
}: {
  commit: GitCommit;
  onClick(): void;
}) {
  return (
    <button className="scm-history-row" onClick={onClick} title={commit.id}>
      <Icon name={commit.parents.length > 1 ? "git" : "clock"} size={15} />
      <span>
        <strong>{commit.subject || tr("Untitled commit")}</strong>
        {commit.refs && <span className="scm-ref-label">{commit.refs}</span>}
        <small>
          {commit.author} · {new Date(commit.date).toLocaleDateString()} ·{" "}
          {commit.id.slice(0, 7)}
        </small>
      </span>
    </button>
  );
}
export function History({
  api,
  status,
  revision,
}: {
  api: RepositoryUI;
  status: GitStatus;
  revision: number;
}) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [file, setFile] = useState(""),
    [path, setPath] = useState(""),
    [ref, setRef] = useState("HEAD");
  const { data, error, loading } = useQuery<GitLog>(
    (signal) =>
      api.request(
        "log",
        {
          ref: ref === "HEAD" && !status.head ? undefined : ref,
          search: query,
          path: path || undefined,
          limit: 40,
        },
        signal,
      ),
    [query, path, ref, revision],
  );
  const [older, setOlder] = useState<GitCommit[]>([]),
    [more, setMore] = useState(false),
    [paging, setPaging] = useState(false);
  const pagingController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setOlder([]);
    setMore(false);
    setPaging(false);
    return () => pagingController.current?.abort();
  }, [query, path, ref, revision]);
  const commits = [...(data?.commits ?? []), ...older];
  return (
    <div className="scm-section-content">
      <form
        className="scm-filter-form"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search);
          setPath(file);
        }}
      >
        <input
          aria-label={tr("Search commit messages")}
          placeholder={tr("Search commit messages")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="scm-input-row">
          <input
            aria-label={tr("History file path")}
            placeholder={tr("File path (optional)")}
            value={file}
            onChange={(event) => setFile(event.target.value)}
          />
          <button className="button" type="submit">
            {tr("Search")}
          </button>
        </div>
        <Select
          label={tr("History branch")}
          value={ref}
          options={[
            { value: "HEAD", label: tr("Current branch") },
            ...status.refs.map((branch) => ({
              value: branch.ref,
              label: branch.name,
            })),
          ]}
          onChange={(value) => {
            setRef(value);
          }}
        />
      </form>
      <Feedback error={error} loading={loading} />
      {!loading && !error && !commits.length && (
        <p className="scm-empty">{tr("No commits found")}</p>
      )}
      {commits.map((commit) => (
        <CommitRow
          key={commit.id}
          commit={commit}
          onClick={() => api.openCommit(commit.id)}
        />
      ))}
      {(older.length ? more : data?.hasMore) && (
        <button
          className="button scm-load-more"
          disabled={paging || loading}
          onClick={() => {
            setPaging(true);
            const controller = new AbortController();
            pagingController.current = controller;
            api.report(async () => {
              try {
                const page = await api.request<GitLog>(
                  "log",
                  {
                    ref: data?.commits[0]?.id ?? ref,
                    search: query,
                    path: path || undefined,
                    limit: 40,
                    skip: commits.length,
                  },
                  controller.signal,
                );
                if (controller.signal.aborted) return;
                setOlder((previous) => [...previous, ...page.commits]);
                setMore(page.hasMore);
              } catch (error) {
                if (!controller.signal.aborted) throw error;
              } finally {
                if (!controller.signal.aborted) setPaging(false);
              }
            });
          }}
        >
          {tr("Load older commits")}
        </button>
      )}
    </div>
  );
}
export function Branches({
  api,
  status,
  pending,
  run,
}: {
  api: RepositoryUI;
  status: GitStatus;
  pending: boolean;
  run(action: () => Promise<unknown>): void;
}) {
  const [filter, setFilter] = useState("");
  const ask = api.options.workbench.ask.bind(api.options.workbench),
    prompt = api.options.workbench.prompt.bind(api.options.workbench);
  return (
    <div className="scm-section-content">
      <div className="scm-section-actions">
        <button
          className="button"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const name = await prompt(tr("New branch name"));
              if (name) await api.perform("branchCreate", { name });
            })
          }
        >
          <Icon name="plus" />
          {tr("Create branch")}
        </button>
        <IconButton
          icon="refresh"
          label="Fetch all remotes"
          disabled={pending || !status.remotes.length}
          onClick={() => run(() => api.perform("fetch"))}
        />
      </div>
      <input
        className="scm-filter"
        aria-label={tr("Filter branches")}
        placeholder={tr("Filter branches")}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {[false, true].map((remote) => (
        <section
          key={String(remote)}
          aria-label={tr(remote ? "Remote branches" : "Local branches")}
        >
          <h3 className="scm-section-title">
            {tr(remote ? "Remote branches" : "Local branches")}
          </h3>
          {status.refs
            .filter(
              (branch) =>
                branch.remote === remote &&
                branch.name.toLowerCase().includes(filter.toLowerCase()),
            )
            .map((branch) => (
              <div className="scm-branch-card" key={branch.ref}>
                <div className="scm-card-title">
                  <Icon name="git" size={14} />
                  <strong>{branch.name}</strong>
                  {branch.current && (
                    <span className="scm-pill">{tr("Current")}</span>
                  )}
                </div>
                <small>
                  {branch.upstream ? `↑ ${branch.upstream} · ` : ""}
                  {branch.subject}
                </small>
                <div className="scm-card-actions">
                  {!branch.current && (
                    <button
                      disabled={pending}
                      onClick={() =>
                        run(async () => {
                          if (remote) {
                            const name = await prompt(
                              tr("Local tracking branch name"),
                              branch.name.slice(branch.name.indexOf("/") + 1),
                            );
                            if (name)
                              await api.perform("branchTrack", {
                                ref: branch.ref,
                                name,
                              });
                          } else
                            await api.perform("checkout", {
                              branch: branch.name,
                            });
                        })
                      }
                    >
                      {tr(remote ? "Track branch" : "Switch")}
                    </button>
                  )}
                  {!branch.current && (
                    <button
                      disabled={pending || !!status.operation}
                      onClick={() =>
                        run(async () => {
                          if (
                            (await ask(
                              tr("Merge branch"),
                              tr("Merge {0} into {1}?", {
                                "0": branch.name,
                                "1": status.branch,
                              }),
                              ["Merge", "Cancel"],
                            )) === "Merge"
                          )
                            await api.perform("merge", { ref: branch.ref });
                        })
                      }
                    >
                      {tr("Merge into current")}
                    </button>
                  )}
                  {!remote && (
                    <button
                      disabled={pending}
                      onClick={() =>
                        run(async () => {
                          const name = await prompt(
                            tr("Rename branch"),
                            branch.name,
                          );
                          if (name && name !== branch.name)
                            await api.perform("branchRename", {
                              branch: branch.name,
                              name,
                            });
                        })
                      }
                    >
                      {tr("Rename")}
                    </button>
                  )}
                  {!remote && !branch.current && (
                    <button
                      disabled={pending}
                      onClick={() =>
                        run(async () => {
                          if (
                            (await ask(
                              tr("Delete local branch?"),
                              tr(
                                "Delete {0}? Git will keep it if it contains unmerged commits.",
                                { "0": branch.name },
                              ),
                              ["Delete Branch", "Cancel"],
                              true,
                            )) === "Delete Branch"
                          )
                            await api.perform("branchDelete", {
                              branch: branch.name,
                              confirm: true,
                            });
                        })
                      }
                    >
                      {tr("Delete")}
                    </button>
                  )}
                </div>
              </div>
            ))}
        </section>
      ))}
      <section aria-label={tr("Remotes")}>
        <div className="scm-section-actions">
          <h3 className="scm-section-title">{tr("Remotes")}</h3>
          <IconButton
            icon="plus"
            label="Add remote"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const name = await prompt(tr("Remote name"), "origin");
                if (!name) return;
                const url = await prompt(tr("Repository URL"));
                if (url) await api.perform("remoteAdd", { name, url });
              })
            }
          />
        </div>
        {!status.remotes.length && (
          <p className="scm-hint">
            {tr("Add a remote to publish and share this repository.")}
          </p>
        )}
        {status.remotes.map((remote) => (
          <div className="scm-branch-card" key={remote.name}>
            <div className="scm-card-title">
              <Icon name="cloud" size={14} />
              <strong>{remote.name}</strong>
              <IconButton
                icon="trash"
                label={`Remove remote ${remote.name}`}
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    if (
                      (await ask(
                        tr("Remove remote?"),
                        tr(
                          "Remove {0} and its tracking references? The remote repository remains intact.",
                          { "0": remote.name },
                        ),
                        ["Remove Remote", "Cancel"],
                        true,
                      )) === "Remove Remote"
                    )
                      await api.perform("remoteRemove", {
                        remote: remote.name,
                        confirm: true,
                      });
                  })
                }
              />
            </div>
            <small className="scm-remote-url">{remote.fetchUrl}</small>
            {remote.pushUrl !== remote.fetchUrl && (
              <small className="scm-remote-url">↑ {remote.pushUrl}</small>
            )}
            <button
              className="button"
              disabled={
                pending ||
                !status.head ||
                !status.branches.includes(status.branch)
              }
              onClick={() =>
                run(() => api.perform("publish", { remote: remote.name }))
              }
            >
              {tr("Publish current branch")}
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
export function Stashes({
  api,
  status,
  pending,
  revision,
  run,
}: {
  api: RepositoryUI;
  status: GitStatus;
  pending: boolean;
  revision: number;
  run(action: () => Promise<unknown>): void;
}) {
  const [message, setMessage] = useState(""),
    [includeUntracked, setIncludeUntracked] = useState(true);
  const { data, error, loading } = useQuery<GitStash[]>(
    (signal) => api.request("stashes", {}, signal),
    [revision],
  );
  return (
    <div className="scm-section-content">
      <form
        className="scm-filter-form"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            if (
              await api.perform("stashSave", {
                message: message.trim(),
                includeUntracked,
              })
            )
              setMessage("");
          });
        }}
      >
        <input
          aria-label={tr("Stash message")}
          placeholder={tr("Describe work to save for later")}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <label className="scm-checkbox">
          <input
            type="checkbox"
            checked={includeUntracked}
            onChange={(event) => setIncludeUntracked(event.target.checked)}
          />
          {tr("Include untracked files")}
        </label>
        <button
          className="button"
          disabled={
            pending ||
            !message.trim() ||
            !status.changes.length ||
            !!status.operation
          }
        >
          {tr("Stash changes")}
        </button>
      </form>
      <Feedback error={error} loading={loading} />
      {!loading && !error && !data?.length && (
        <p className="scm-empty">{tr("No stashes yet")}</p>
      )}
      {data?.map((stash) => (
        <div className="scm-branch-card" key={stash.id + stash.ref}>
          <button
            className="scm-stash-open"
            onClick={() => api.openStash(stash)}
          >
            <strong>{stash.message}</strong>
            <small>
              {stash.ref} · {new Date(stash.date).toLocaleString()}
            </small>
          </button>
          <div className="scm-card-actions">
            <button
              disabled={pending}
              onClick={() => run(() => api.perform("stashApply", { ...stash }))}
            >
              {tr("Apply")}
            </button>
            <button
              disabled={pending}
              onClick={() => run(() => api.perform("stashPop", { ...stash }))}
            >
              {tr("Pop")}
            </button>
            <button
              disabled={pending}
              onClick={() =>
                run(async () => {
                  if (
                    (await api.options.workbench.ask(
                      tr("Delete stash?"),
                      stash.message,
                      ["Delete Stash", "Cancel"],
                      true,
                    )) === "Delete Stash"
                  )
                    await api.perform("stashDrop", { ...stash, confirm: true });
                })
              }
            >
              {tr("Delete")}
            </button>
          </div>
        </div>
      ))}
      <p className="scm-hint">
        {tr(
          "Apply keeps the stash. Pop removes it after a successful restore. Both restore staged changes too.",
        )}
      </p>
    </div>
  );
}
export function CommitDetails({
  api,
  refId,
}: {
  api: RepositoryUI;
  refId: string;
}) {
  const { data, error, loading } = useQuery<GitCommitDetail>(
    (signal) => api.request("show", { ref: refId }, signal),
    [refId],
  );
  const [file, setFile] = useState(""),
    [pending, setPending] = useState(false);
  const selection = file || data?.files[0]?.path;
  const diff = useQuery<GitDiff>(
    (signal) =>
      selection
        ? api.request("commitDiff", { ref: refId, path: selection }, signal)
        : Promise.resolve({ before: "", after: "", diff: "" }),
    [refId, selection],
  );
  const act = (method: "revert" | "cherryPick") => {
    if (!data || pending) return;
    setPending(true);
    api.report(async () => {
      try {
        const label =
          method === "revert" ? "Revert Commit" : "Cherry-pick Commit";
        if (
          (await api.options.workbench.ask(
            tr(label),
            data.commit.subject +
              "\n\n" +
              tr(
                method === "revert"
                  ? "Create a new commit reversing this change on the current branch?"
                  : "Apply this change as a new commit on the current branch?",
              ),
            [label, "Cancel"],
          )) === label
        )
          await api.perform(method, { ref: data.commit.id, confirm: true });
      } finally {
        setPending(false);
      }
    });
  };
  return (
    <div className="scm-commit-details">
      <Feedback error={error} loading={loading} />
      {data && (
        <>
          <header>
            <h2>{data.commit.subject}</h2>
            <p>
              {data.commit.author} ·{" "}
              {new Date(data.commit.date).toLocaleString()}
            </p>
            <code>{data.commit.id}</code>
            {data.commit.body && (
              <p className="scm-commit-body">{data.commit.body}</p>
            )}
            <div className="scm-card-actions">
              <button
                className="button"
                disabled={pending || data.commit.parents.length > 1}
                onClick={() => act("revert")}
              >
                {tr("Revert Commit")}
              </button>
              <button
                className="button"
                disabled={pending || data.commit.parents.length > 1}
                onClick={() => act("cherryPick")}
              >
                {tr("Cherry-pick Commit")}
              </button>
            </div>
            {data.commit.parents.length > 1 && (
              <p className="scm-hint">
                {tr("Merge commit changes are shown against the first parent.")}
              </p>
            )}
          </header>
          <div className="scm-commit-files">
            <nav aria-label={tr("Commit files")}>
              {data.files.map((item) => (
                <button
                  key={item.path}
                  className={selection === item.path ? "active" : ""}
                  aria-pressed={selection === item.path}
                  onClick={() => setFile(item.path)}
                >
                  <span className="scm-status" data-status={item.status[0]}>
                    {item.status[0]}
                  </span>
                  <span>
                    {item.originalPath
                      ? `${item.originalPath} → ${item.path}`
                      : item.path}
                  </span>
                </button>
              ))}
              {!data.files.length && (
                <p className="scm-empty">{tr("No file changes")}</p>
              )}
            </nav>
            <div className="scm-commit-patch">
              <Feedback error={diff.error} loading={diff.loading} />
              {diff.data?.binary ? (
                <p className="scm-empty">{tr("Binary file changed")}</p>
              ) : (
                diff.data && (
                  <Patch text={diff.data.diff || tr("No content changes")} />
                )
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
export function StashDetails({
  api,
  stash,
}: {
  api: RepositoryUI;
  stash: GitStash;
}) {
  const { data, error, loading } = useQuery<{ diff: string }>(
    (signal) => api.request("stashDiff", { ...stash }, signal),
    [stash.id, stash.ref],
  );
  return (
    <div className="scm-commit-details">
      <header>
        <h2>{stash.message}</h2>
        <p>
          {stash.ref} · {new Date(stash.date).toLocaleString()}
        </p>
      </header>
      <Feedback error={error} loading={loading} />
      {data && <Patch text={data.diff || tr("No content changes")} />}
    </div>
  );
}
