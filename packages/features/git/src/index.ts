import {
  Icon,
  IconButton,
  Select,
  FileBadge,
  translate as tr,
} from "@oxbit/ui";
import React, { useEffect, useState } from "react";
import type {
  Extension,
  FeatureOptions,
  GitChange as Change,
  GitStatus as Status,
  GitDiff,
  GitStash,
} from "@oxbit/sdk";
import {
  History,
  Branches,
  Stashes,
  CommitDetails,
  StashDetails,
  Patch,
  type RepositoryUI,
} from "./views.js";
const emptyStatus = (): Status => ({
  repository: false,
  branch: "",
  branches: [],
  refs: [],
  changes: [],
  remotes: [],
  ahead: 0,
  behind: 0,
});
export function resolveConflict(
  text: string,
  choice: "current" | "incoming" | "both",
): string {
  return text.replace(
    /^<<<<<<<[^\n]*\n([\s\S]*?)^=======[^\n]*\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm,
    (_match, original: string, incoming: string) => {
      const current = original.replace(/^\|{7}[^\n]*\n[\s\S]*$/m, "");
      return choice === "current"
        ? current
        : choice === "incoming"
          ? incoming
          : current + incoming;
    },
  );
}
export function unifiedDiff(before: string, after: string): string {
  if (before === after) return "No changes";
  const left = before.split("\n"),
    right = after.split("\n"),
    lines = ["--- Previous content", "+++ Current content"];
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const a = left.slice(prefix, left.length - suffix),
    b = right.slice(prefix, right.length - suffix);
  lines.push(`@@ -${prefix + 1},${a.length} +${prefix + 1},${b.length} @@`);
  if (a.length * b.length > 1000000) {
    lines.push(...a.map((line) => "-" + line), ...b.map((line) => "+" + line));
    return lines.join("\n");
  }
  const width = b.length + 1,
    table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? 1 + table[(i + 1) * width + j + 1]
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(" " + a[i++]);
      j++;
    } else if (
      j < b.length &&
      (i === a.length || table[i * width + j + 1] > table[(i + 1) * width + j])
    )
      lines.push("+" + b[j++]);
    else lines.push("-" + a[i++]);
  }
  return lines.join("\n");
}
const staged = (change: Change) =>
  !change.conflict && ![" ", "?", ""].includes(change.index);
const unstaged = (change: Change) =>
  !change.conflict && ![" ", ""].includes(change.working);
export function createFeature(o: FeatureOptions): Extension {
  let status: Status = emptyStatus(),
    error = "",
    progress = "",
    cloning = false,
    disposed = false;
  let revision = 0;
  let commitMessage = "",
    committing = false;
  const tabs = ["Changes", "History", "Branches", "Stashes"] as const;
  let tab: (typeof tabs)[number] = "Changes";
  const selectTab = (next: typeof tab) => {
    tab = next;
    changed();
  };
  const listeners = new Set<() => void>();
  let cloneController: AbortController | undefined;
  let operationController: AbortController | undefined;
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const request = <T = any>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) => {
    if (!o.runtime?.connected)
      return Promise.reject(
        new Error("Connect to a trusted runtime workspace to use Git"),
      );
    return o.runtime.request<T>("git." + method, params, { signal });
  };
  let statusRequest = 0;
  const refresh = async () => {
    const sequence = ++statusRequest;
    try {
      const next = await request<Status>("status");
      if (sequence !== statusRequest || disposed) return;
      status = next;
      status.changes ??= [];
      status.branches ??= [];
      status.refs ??= [];
      status.remotes ??= [];
      revision++;
      error = "";
      o.kernel.context.set("gitRepo", status.repository);
      o.kernel.context.set("gitChanges", status.changes.length > 0);
      o.kernel.context.set("gitStaged", status.changes.some(staged));
      changed();
    } catch (failure) {
      if (sequence !== statusRequest || disposed) return;
      status = emptyStatus();
      error = String(failure);
      o.kernel.context.set("gitRepo", false);
      o.kernel.context.set("gitChanges", false);
      o.kernel.context.set("gitStaged", false);
      changed();
      throw failure;
    }
  };
  const report = (action: () => Promise<unknown>) => {
    void action().catch((failure) => {
      error = String(failure);
      changed();
      o.workbench.notify(error, "error");
    });
  };
  const saveBuffers = async (paths?: string[], stageOnly = false) => {
    const dirty = [...o.documents.documents.values()].filter(
      (document) => document.dirty && (!paths || paths.includes(document.path)),
    );
    if (!dirty.length) return true;
    const choice = await o.workbench.ask(
      tr("Unsaved editor changes"),
      tr("{0} files have unsaved edits. Save them before continuing?", {
        "0": dirty.length,
      }),
      stageOnly
        ? ["Save All and Continue", "Stage Saved Content", "Cancel"]
        : ["Save All and Continue", "Cancel"],
    );
    if (stageOnly && choice === "Stage Saved Content") return true;
    if (choice !== "Save All and Continue") return false;
    for (const document of dirty) await o.documents.save(document.path);
    return true;
  };
  const perform = async (
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (
      [
        "checkout",
        "branchCreate",
        "branchTrack",
        "pull",
        "merge",
        "continue",
        "abort",
        "stashSave",
        "stashApply",
        "stashPop",
        "cherryPick",
        "revert",
      ].includes(method) &&
      !(await saveBuffers())
    )
      return false;
    if (operationController)
      throw new Error("Wait for the current Git operation to finish");
    operationController = new AbortController();
    error = "";
    progress = "";
    changed();
    try {
      await request(method, params, operationController.signal);
    } finally {
      operationController = undefined;
      await refresh().catch(() => {});
      await o.workbench.refreshFiles();
      changed();
    }
    return true;
  };
  const api: RepositoryUI = {
    options: o,
    request,
    perform,
    report,
    openCommit: (refId) =>
      o.workbench.openView(
        "git-commit:" + refId,
        tr("Commit") + " " + refId.slice(0, 7),
        CommitDetails,
        { api, refId },
      ),
    openStash: (stash: GitStash) =>
      o.workbench.openView(
        "git-stash:" + stash.id,
        stash.message,
        StashDetails,
        { api, stash },
      ),
  };
  const stageAll = async () => {
    await refresh();
    if (!(await saveBuffers(undefined, true))) return;
    if (status.changes.some((change) => change.conflict))
      throw new Error(
        "Resolve and stage conflicted files individually before staging all changes",
      );
    await request("stageAll");
    await refresh();
  };
  const stage = async (path: string, save = false) => {
    const doc = o.documents.get(path);
    if (doc?.dirty) {
      const choice = save
        ? "Save and Stage"
        : await o.workbench.ask(
            tr("Stage unsaved file?"),
            tr("{0} has unsaved edits.", { "0": path }),
            ["Save and Stage", "Stage Saved Content", "Cancel"],
          );
      if (!choice || choice === "Cancel") return;
      if (choice === "Save and Stage") await o.documents.save(path);
    }
    if (status.changes.find((change) => change.path === path)?.conflict) {
      const disk = await request<GitDiff>("diff", { path });
      if (/^<<<<<<<|^=======|^>>>>>>>/m.test(disk.after))
        throw new Error(
          "Remove conflict markers and save the file before staging the resolution",
        );
    }
    await request("stage", { path });
    await refresh();
  };
  const discard = async (path: string, confirmed = false) => {
    if (
      !confirmed &&
      (await o.workbench.ask(
        tr("Discard file changes?"),
        tr(
          "Discard disk changes in {0}? Unsaved editor content remains in its buffer.",
          {
            "0": path,
          },
        ),
        ["Discard", "Cancel"],
        true,
      )) !== "Discard"
    )
      return;
    await request("discard", { path, confirm: true });
    await refresh();
  };
  const discardAll = async () => {
    await refresh();
    const changes = status.changes.filter(unstaged);
    if (!changes.length) return;
    if (
      (await o.workbench.ask(
        tr("Discard all disk changes?"),
        tr(
          "Discard changes in {0} files? Unsaved editor content remains in its buffers.",
          {
            "0": changes.length,
          },
        ),
        ["Discard All", "Cancel"],
        true,
      )) !== "Discard All"
    )
      return;
    const failures: string[] = [];
    for (const change of changes)
      try {
        await request("discard", { path: change.path, confirm: true });
      } catch (failure) {
        failures.push(`${change.path}: ${String(failure)}`);
      }
    await refresh();
    if (failures.length) throw new Error(failures.join("\n"));
  };
  const commit = async (message?: string) => {
    if (committing) return;
    message ??=
      commitMessage || (await o.workbench.prompt(tr("Commit message")));
    if (message === undefined) return;
    if (!message.trim()) throw new Error("Enter a commit message");
    committing = true;
    changed();
    try {
      await request("commit", { message });
      if (commitMessage === message) commitMessage = "";
      await refresh();
      o.workbench.notify("Commit created");
    } finally {
      committing = false;
      changed();
    }
  };
  let branchOpenRequest = 0;
  const checkout = async (branch?: string) => {
    await refresh();
    if (!branch) {
      branchOpenRequest++;
      tab = "Changes";
      o.workbench.openPanel("scm");
      changed();
      return;
    }
    if (!branch) return;
    if (!status.branches.includes(branch))
      throw new Error("Choose an existing local branch");
    await perform("checkout", { branch });
  };
  const clone = async () => {
    if (cloning) throw new Error("A clone is already running");
    const url = await o.workbench.prompt(tr("Repository URL"));
    if (!url) return;
    const destination = await o.workbench.prompt(
      tr("Destination folder inside the workspace"),
      url
        .split("/")
        .at(-1)
        ?.replace(/\.git$/, "") ?? "repository",
    );
    if (!destination) return;
    cloning = true;
    progress = "Cloning repository…";
    error = "";
    cloneController = new AbortController();
    changed();
    o.workbench.openPanel("scm");
    try {
      await request("clone", { url, destination }, cloneController.signal);
      progress = `Cloned into ${destination}`;
      o.workbench.notify(progress);
      await o.workbench.refreshFiles();
    } catch (failure) {
      error = String(failure);
      progress = cloneController.signal.aborted
        ? "Clone cancelled; incomplete destination removed."
        : "Clone failed. Runtime credential helpers supply authentication.";
      throw failure;
    } finally {
      cloning = false;
      cloneController = undefined;
      changed();
    }
  };
  function Diff({
    path,
    staged: isStaged = false,
    mode,
  }: {
    path: string;
    staged?: boolean;
    mode?: "disk" | "base";
  }) {
    const [data, setData] = useState<GitDiff>(),
      [failure, setFailure] = useState(""),
      [inline, setInline] = useState(
        o.kernel.configuration.get("scm.diffLayout") === "inline",
      );
    const [version, render] = useState(0);
    const [applying, setApplying] = useState(false);
    const [hunkView, setHunkView] = useState(false);
    useEffect(() => {
      const controller = new AbortController();
      const load = mode
        ? (async () => {
            const document = await o.documents.open(path),
              before =
                mode === "base"
                  ? document.savedText
                  : (o.runtime && o.filesystem.id.startsWith("runtime:")
                      ? await o.runtime.request<{ text: string }>("fs.read", {
                          path,
                        })
                      : await o.filesystem.read(path)
                    ).text;
            return {
              before,
              after: document.text.toString(),
              diff: unifiedDiff(before, document.text.toString()),
            };
          })()
        : request("diff", { path, staged: isStaged }, controller.signal);
      setFailure("");
      void load.then(
        (value) => {
          if (!controller.signal.aborted) setData(value);
        },
        (reason) => {
          if (!controller.signal.aborted) setFailure(String(reason));
        },
      );
      return () => controller.abort();
    }, [path, isStaged, mode, version]);
    useEffect(() => {
      let seen = revision;
      const update = () => {
        if (seen !== revision) {
          seen = revision;
          render((value) => value + 1);
        }
      };
      listeners.add(update);
      const off = o.kernel.events.on("document.change", () =>
        render((value) => value + 1),
      );
      return () => {
        listeners.delete(update);
        off.dispose();
      };
    }, []);
    const buffer = o.documents.get(path);
    return React.createElement(
      "div",
      {
        className: "diff-editor",
        style: { height: "100%", display: "flex", flexDirection: "column" },
      },
      React.createElement(
        "header",
        {
          style: { padding: 8, display: "flex", gap: 8, alignItems: "center" },
        },
        React.createElement(
          "span",
          { style: { flex: 1 } },
          path +
            " · " +
            (mode === "disk"
              ? "Buffer against disk"
              : mode === "base"
                ? "Buffer against saved revision"
                : isStaged
                  ? "Index against HEAD"
                  : "Disk against index"),
        ),
        React.createElement(
          "button",
          {
            onClick: () => {
              setHunkView(false);
              setInline(!inline);
            },
          },
          inline ? tr("Side by side") : tr("Inline"),
        ),
        !!data?.hunks?.length &&
          React.createElement(
            "button",
            { onClick: () => setHunkView(!hunkView), "aria-pressed": hunkView },
            tr("Review hunks"),
          ),
        buffer?.dirty &&
          React.createElement(
            "button",
            { onClick: () => report(() => stage(path, true)) },
            tr("Save and Stage"),
          ),
      ),
      failure && React.createElement("p", { role: "alert" }, failure),
      data?.binary &&
        React.createElement(
          "p",
          { className: "scm-empty" },
          tr("Binary file changed"),
        ),
      hunkView &&
        data &&
        React.createElement(
          "div",
          { className: "scm-hunk-list" },
          ...(data.hunks ?? []).map((hunk) =>
            React.createElement(
              "section",
              {
                key: hunk.index,
                "aria-label": tr("Hunk {0}", { "0": hunk.index + 1 }),
              },
              React.createElement(
                "div",
                { className: "scm-hunk-toolbar" },
                React.createElement("span", null, hunk.header),
                React.createElement(
                  "button",
                  {
                    className: "button",
                    disabled: applying,
                    onClick: () => {
                      setApplying(true);
                      report(async () => {
                        try {
                          await request("hunk", {
                            path,
                            staged: isStaged,
                            fingerprint: data.fingerprint,
                            hunk: hunk.index,
                          });
                          await refresh();
                        } finally {
                          render((value) => value + 1);
                          setApplying(false);
                        }
                      });
                    },
                  },
                  tr(isStaged ? "Unstage hunk {0}" : "Stage hunk {0}", {
                    "0": hunk.index + 1,
                  }),
                ),
              ),
              React.createElement(Patch, { text: hunk.patch }),
            ),
          ),
          !data.hunks?.length &&
            React.createElement(
              "p",
              { className: "scm-empty" },
              tr("No remaining hunks"),
            ),
        ),
      data &&
        !data.binary &&
        !hunkView &&
        React.createElement(
          "div",
          { style: { display: "flex", flex: 1, overflow: "auto" } },
          ...(inline
            ? [data.diff || unifiedDiff(data.before, data.after)]
            : [data.before, data.after]
          ).map((text, index) =>
            React.createElement(
              "pre",
              {
                key: index,
                "aria-label": inline
                  ? tr("Inline diff")
                  : index === 0
                    ? tr("Previous content")
                    : tr("Current content"),
                style: {
                  flex: 1,
                  padding: 12,
                  margin: 0,
                  overflow: "auto",
                  background: inline
                    ? "var(--bg-editor)"
                    : index === 0
                      ? "var(--del-soft)"
                      : "var(--add-soft)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-mono-font-size)",
                },
              },
              ...(inline
                ? text.split("\n").map((line, index) =>
                    React.createElement(
                      "span",
                      {
                        key: index,
                        style: {
                          display: "block",
                          background:
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "var(--add-soft)"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "var(--del-soft)"
                                : "transparent",
                        },
                      },
                      line || " ",
                    ),
                  )
                : [text]),
            ),
          ),
        ),
      data?.after?.includes("<<<<<<<") &&
        React.createElement(
          "div",
          { style: { padding: 8, display: "flex", gap: 8 } },
          ...(["current", "incoming", "both"] as const).map((choice) =>
            React.createElement(
              "button",
              {
                key: choice,
                onClick: () =>
                  report(async () => {
                    const doc = await o.documents.open(path);
                    doc.replace(resolveConflict(doc.text.toString(), choice));
                    o.workbench.notify(
                      "Conflict resolution is in the unsaved buffer",
                    );
                  }),
              },
              "Accept " + choice,
            ),
          ),
        ),
    );
  }
  const restore = async (path?: string) => {
    path ??= o.workbench.activePath();
    if (!path) return;
    const snapshot = await request("restore", { path }),
      document = o.documents.get(path);
    if (document?.dirty) o.documents.markSaved(path, snapshot);
    else await o.documents.reload(path);
    await refresh();
  };
  const compare = (args?: { path?: string; mode?: "disk" | "base" }) => {
    const path = args?.path ?? o.workbench.activePath();
    if (path)
      o.workbench.openView("compare:" + path, path + " Comparison", Diff, {
        path,
        mode: args?.mode ?? "disk",
      });
  };
  const diff = (path?: string, isStaged = false) => {
    path ??= o.workbench.activePath();
    if (path)
      o.workbench.openView(
        "diff:" + path + (isStaged ? ":staged" : ""),
        path + " Changes",
        Diff,
        {
          path,
          staged: isStaged,
        },
      );
  };
  function Panel() {
    const [, render] = useState(0);
    const message = commitMessage;
    const setMessage = (value: string) => {
      commitMessage = value;
      changed();
    };
    const [view, setView] = useState(() =>
      localStorage.getItem("oxbit.scm.view") === "tree" ? "tree" : "list",
    );
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [pending, setPending] = useState(false);
    const [filter, setFilter] = useState("");
    useEffect(() => {
      const listener = () => render((value) => value + 1);
      listeners.add(listener);
      void refresh().catch(() => {});
      return () => {
        listeners.delete(listener);
      };
    }, []);
    const h = React.createElement;
    const run = (action: () => Promise<unknown>) => {
      if (pending) return;
      setPending(true);
      report(async () => {
        try {
          await action();
        } finally {
          setPending(false);
        }
      });
    };
    const toggle = (key: string) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    const hasStaged = status.changes.some(staged);
    const canCommit =
      hasStaged &&
      !!message.trim() &&
      !pending &&
      !committing &&
      !status.changes.some((change) => change.conflict);
    const submit = () => {
      if (canCommit) run(() => commit(message).then(() => setMessage("")));
    };
    const file = (change: Change, group: string, depth = 0) => {
      const isStaged = group === "staged";
      const name = change.path.split("/").at(-1)!;
      const directory = change.path.includes("/")
        ? change.path.slice(0, -(name.length + 1))
        : "";
      const dirty = o.documents.get(change.path)?.dirty;
      return h(
        "div",
        {
          key: change.path,
          className: "scm-file",
          style: { paddingLeft: 8 + depth * 12 },
        },
        h(
          "button",
          {
            className: "scm-file-open",
            title: change.path,
            "aria-label": change.path,
            onClick: () => diff(change.path, isStaged),
          },
          h(FileBadge, { path: change.path }),
          h("span", { className: "scm-filename" }, name),
          change.originalPath &&
            h(
              "span",
              { className: "scm-directory", title: change.originalPath },
              "← " + change.originalPath,
            ),
          view === "list" &&
            directory &&
            h("span", { className: "scm-directory" }, directory),
          dirty &&
            h("span", { className: "dirty-dot", title: tr("Unsaved changes") }),
        ),
        h(
          "span",
          {
            className: "scm-status",
            "data-status": isStaged ? change.index : change.working,
          },
          isStaged ? change.index : change.working,
        ),
        h(
          "div",
          { className: "scm-file-actions" },
          h(IconButton, {
            icon: isStaged ? "minus" : "plus",
            label: (isStaged ? "Unstage " : "Stage ") + change.path,
            disabled: pending,
            onClick: () =>
              run(() =>
                isStaged
                  ? request("unstage", { path: change.path }).then(refresh)
                  : stage(change.path),
              ),
          }),
          !isStaged &&
            !change.conflict &&
            h(IconButton, {
              icon: "refresh",
              label: "Discard " + change.path,
              disabled: pending,
              onClick: () => run(() => discard(change.path)),
            }),
          dirty &&
            h(IconButton, {
              icon: "save",
              label: "Save and Stage " + change.path,
              disabled: pending,
              onClick: () => run(() => stage(change.path, true)),
            }),
        ),
      );
    };
    const tree = (
      changes: Change[],
      group: string,
      prefix = "",
      depth = 0,
    ): React.ReactNode[] => {
      const folders = new Map<string, Change[]>();
      const files: Change[] = [];
      for (const change of changes) {
        const rest = change.path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) files.push(change);
        else {
          const folder = rest.slice(0, slash);
          if (!folders.has(folder)) folders.set(folder, []);
          folders.get(folder)!.push(change);
        }
      }
      return [
        ...[...folders]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, children]) => {
            const path = prefix + name + "/",
              key = group + ":" + path,
              expanded = !collapsed.has(key);
            return h(
              "div",
              { key },
              h(
                "button",
                {
                  className: "scm-folder",
                  title: path,
                  "aria-expanded": expanded,
                  style: { paddingLeft: 8 + depth * 12 },
                  onClick: () => toggle(key),
                },
                h(Icon, { name: expanded ? "chevD" : "chevR", size: 12 }),
                h(Icon, { name: expanded ? "folderOpen" : "folder", size: 14 }),
                h("span", null, name),
                h("small", null, children.length),
              ),
              expanded && tree(children, group, path, depth + 1),
            );
          }),
        ...files
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((change) => file(change, group, depth)),
      ];
    };
    return h(
      "div",
      {
        className: "scm-panel",
        onContextMenu: (event: React.MouseEvent) => {
          event.preventDefault();
          o.workbench.showContextMenu("scm", event.clientX, event.clientY);
        },
      },
      h(
        "div",
        { className: "scm-compose" },
        h(
          "div",
          { className: "scm-toolbar" },
          h("span", { className: "scm-repository-label" }, tr("Repository")),
          h(IconButton, {
            icon: "refresh",
            label: "Refresh",
            disabled: pending,
            onClick: () => run(refresh),
          }),
          h(IconButton, {
            icon: "arrowUp",
            label: status.upstream ? "Push" : "Publish branch",
            disabled: pending || !status.head,
            onClick: () =>
              status.upstream
                ? run(() => perform("push"))
                : selectTab("Branches"),
          }),
          h(IconButton, {
            icon: "arrowDown",
            label: "Pull",
            disabled: pending || !status.upstream,
            onClick: () => run(() => perform("pull")),
          }),
          h(IconButton, {
            icon: "sync",
            label: "Fetch",
            disabled: pending || !status.remotes.length,
            onClick: () => run(() => perform("fetch")),
          }),
          h(IconButton, {
            icon: "copy",
            label: "Clone",
            disabled: pending || !o.runtime?.connected,
            onClick: () => run(clone),
          }),
          h(IconButton, {
            icon: view === "list" ? "folder" : "menu",
            label:
              view === "list" ? "Switch to tree view" : "Switch to list view",
            onClick: () => {
              const next = view === "list" ? "tree" : "list";
              setView(next);
              localStorage.setItem("oxbit.scm.view", next);
            },
          }),
        ),
        h(Select, {
          className: "scm-branch",
          label: tr("Git branch"),
          icon: "git",
          value: status.branch,
          disabled: pending || !status.branch,
          openRequest: branchOpenRequest,
          onOpen: () => {
            branchOpenRequest = 0;
            void refresh().catch(() => {});
          },
          options: [...new Set([status.branch, ...status.branches])].map(
            (branch) => ({
              value: branch,
              label: branch || tr("No repository"),
              disabled: !status.branches.includes(branch),
            }),
          ),
          onChange: (branch) => {
            if (branch !== status.branch) run(() => checkout(branch));
          },
        }),
        status.repository &&
          h(
            "div",
            { className: "scm-tracking", role: "status" },
            status.upstream
              ? h(
                  "span",
                  { title: status.upstream },
                  status.upstream,
                  " · ↑ ",
                  status.ahead,
                  " ↓ ",
                  status.behind,
                )
              : h(
                  "button",
                  { onClick: () => selectTab("Branches") },
                  tr(status.head ? "Publish branch…" : "No commits yet"),
                ),
          ),
        !status.branch &&
          h(
            "button",
            {
              className: "button",
              disabled: pending || !o.runtime?.connected,
              onClick: () => run(() => request("init").then(refresh)),
            },
            h(Icon, { name: "plus" }),
            tr("Initialize Repository"),
          ),
        tab === "Changes" &&
          status.repository &&
          h("textarea", {
            className: "scm-message",
            "aria-label": tr("Commit message"),
            rows: 3,
            placeholder: tr("Message (Ctrl+Enter to commit)"),
            value: message,
            onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
              setMessage(event.target.value),
            onKeyDown: (event: React.KeyboardEvent) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            },
          }),
        tab === "Changes" &&
          status.repository &&
          h(
            "button",
            {
              className: "button primary scm-commit",
              disabled: !canCommit,
              onClick: submit,
            },
            h(Icon, { name: "check" }),
            tr("Commit staged changes"),
          ),
        error &&
          h(
            "p",
            { className: "scm-feedback error-text", role: "alert" },
            error,
          ),
        progress &&
          h(
            "details",
            { className: "scm-feedback scm-output" },
            h(
              "summary",
              null,
              tr(
                operationController || cloning
                  ? "Git operation running…"
                  : "Git output",
              ),
            ),
            h("pre", null, progress),
          ),
        operationController &&
          h(
            "button",
            {
              className: "button",
              onClick: () => operationController?.abort(),
            },
            tr("Cancel Git operation"),
          ),
        cloning &&
          h(
            "button",
            { className: "button", onClick: () => cloneController?.abort() },
            tr("Cancel Clone"),
          ),
      ),
      status.operation &&
        h(
          "div",
          { className: "scm-operation", role: "status" },
          h("strong", null, tr("{0} in progress", { "0": status.operation })),
          h(
            "p",
            null,
            tr(
              "Resolve conflicts, save the files, and stage each resolution to continue.",
            ),
          ),
          h(
            "div",
            { className: "scm-card-actions" },
            h(
              "button",
              {
                className: "button",
                disabled:
                  pending || status.changes.some((change) => change.conflict),
                onClick: () =>
                  run(() =>
                    perform("continue", { operation: status.operation }),
                  ),
              },
              tr("Continue"),
            ),
            h(
              "button",
              {
                className: "button",
                disabled: pending,
                onClick: () =>
                  run(async () => {
                    const operation = status.operation;
                    if (
                      (await o.workbench.ask(
                        tr("Abort operation?"),
                        tr(
                          "Discard conflict resolutions and return to the state before {0}?",
                          { "0": operation },
                        ),
                        ["Abort", "Cancel"],
                        true,
                      )) === "Abort"
                    )
                      await perform("abort", { operation, confirm: true });
                  }),
              },
              tr("Abort"),
            ),
          ),
        ),
      status.repository &&
        h(
          "div",
          {
            className: "scm-tabs",
            role: "tablist",
            "aria-label": tr("Source control views"),
            onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (tabs.indexOf(tab) +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        tabs.length) %
                      tabs.length;
              selectTab(tabs[next]!);
              (event.currentTarget.children[next] as HTMLButtonElement).focus();
            },
          },
          ...tabs.map((name) =>
            h(
              "button",
              {
                key: name,
                role: "tab",
                id: "scm-tab-" + name,
                "aria-controls": "scm-content",
                "aria-selected": tab === name,
                tabIndex: tab === name ? 0 : -1,
                onClick: () => selectTab(name),
              },
              tr(name),
            ),
          ),
        ),
      tab === "Changes" &&
        status.repository &&
        h("input", {
          className: "scm-filter",
          "aria-label": tr("Filter changed files"),
          placeholder: tr("Filter changed files"),
          value: filter,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            setFilter(event.target.value),
        }),
      status.repository &&
        h(
          "div",
          {
            className: "scm-content",
            id: "scm-content",
            role: "tabpanel",
            "aria-labelledby": "scm-tab-" + tab,
          },
          tab === "History"
            ? h(History, { api, status, revision })
            : tab === "Branches"
              ? h(Branches, { api, status, pending, run })
              : tab === "Stashes"
                ? h(Stashes, { api, status, pending, revision, run })
                : h(
                    "div",
                    { className: "scm-changes" },
                    ...(["conflicts", "staged", "unstaged"] as const).map(
                      (group) => {
                        const all = status.changes.filter(
                          group === "conflicts"
                            ? (change) => change.conflict
                            : group === "staged"
                              ? staged
                              : unstaged,
                        );
                        if (group === "conflicts" && !all.length) return null;
                        const changes = all.filter((change) =>
                          change.path
                            .toLowerCase()
                            .includes(filter.toLowerCase()),
                        );
                        const expanded = !collapsed.has(group);
                        return h(
                          "section",
                          {
                            key: group,
                            className: "scm-group",
                            "aria-label":
                              group === "conflicts"
                                ? tr("Merge changes")
                                : group === "staged"
                                  ? tr("Staged changes")
                                  : tr("Changes"),
                          },
                          h(
                            "div",
                            { className: "scm-group-header" },
                            h(
                              "button",
                              {
                                className: "scm-group-toggle",
                                "aria-expanded": expanded,
                                onClick: () => toggle(group),
                              },
                              h(Icon, {
                                name: expanded ? "chevD" : "chevR",
                                size: 12,
                              }),
                              h(
                                "span",
                                null,
                                group === "conflicts"
                                  ? tr("Merge changes")
                                  : group === "staged"
                                    ? tr("Staged changes")
                                    : tr("Changes"),
                              ),
                              h(
                                "span",
                                { className: "scm-count" },
                                changes.length,
                              ),
                            ),
                            group !== "conflicts" &&
                              h(IconButton, {
                                icon: group === "staged" ? "minus" : "plus",
                                label:
                                  group === "staged"
                                    ? "Unstage All Changes"
                                    : "Stage All Changes",
                                disabled: !changes.length || pending,
                                onClick: () =>
                                  run(() =>
                                    o.kernel.commands.execute(
                                      group === "staged"
                                        ? "git.unstageAll"
                                        : "git.stageAll",
                                    ),
                                  ),
                              }),
                          ),
                          expanded &&
                            (view === "tree"
                              ? tree(changes, group)
                              : changes.map((change) => file(change, group))),
                        );
                      },
                    ),
                    !status.changes.length &&
                      !error &&
                      h(
                        "div",
                        { className: "scm-empty" },
                        h(Icon, { name: "okCircle", size: 24 }),
                        h("span", null, tr("No disk changes")),
                      ),
                  ),
        ),
    );
  }
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.git",
      name: "Source Control",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["git", "filesystem.read", "filesystem.write"],
    },
    activate(ctx) {
      disposed = false;
      ctx.own(
        ctx.services.register("git", {
          status: () => status,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          refresh,
          stage,
          discard,
          diff,
          commit,
          checkout,
          clone,
          restore,
          compare,
        }),
      );
      ctx.own(
        ctx.contributions.register({
          id: "scm",
          kind: "activityView",
          title: "Source Control",
          component: Panel,
          order: 30,
        }),
      );
      const command = (
        id: string,
        title: string,
        run: (args?: any) => unknown,
      ) => ctx.own(ctx.commands.register({ id, title, run }));
      command("git.restore", "Restore Missing File from Git", (args) =>
        restore(args?.path),
      );
      command("git.compare", "Compare Buffer with Disk", compare);
      command("git.refresh", "Refresh Source Control", refresh);
      command("git.init", "Initialize Repository", () =>
        request("init").then(refresh),
      );
      command("git.commit", "Commit Staged Changes", () => commit());
      command("git.push", "Push", () =>
        status.upstream ? perform("push") : showTab("Branches"),
      );
      command("git.fetch", "Fetch", () => perform("fetch"));
      command("git.pull", "Pull (Fast-forward Only)", () => perform("pull"));
      const showTab = (next: typeof tab) => {
        selectTab(next);
        o.workbench.openPanel("scm");
      };
      command("git.history", "Show Commit History", () => showTab("History"));
      command("git.branches", "Manage Branches and Remotes", () =>
        showTab("Branches"),
      );
      command("git.stashes", "Manage Stashes", () => showTab("Stashes"));
      command("git.branchCreate", "Create Branch", async () => {
        const name = await o.workbench.prompt(tr("New branch name"));
        if (name) await perform("branchCreate", { name });
      });
      command("git.publish", "Publish Branch", () => showTab("Branches"));
      command("git.stage", "Stage File", () => {
        const path = o.workbench.activePath();
        if (path) return stage(path);
      });
      command("git.stageAll", "Stage All Changes", stageAll);
      command("git.unstage", "Unstage File", () => {
        const path = o.workbench.activePath();
        if (path) return request("unstage", { path }).then(refresh);
      });
      command("git.unstageAll", "Unstage All Changes", async () => {
        await refresh();
        await request("unstageAll");
        await refresh();
      });
      command("git.discard", "Discard File Changes", () => {
        const path = o.workbench.activePath();
        if (path) return discard(path);
      });
      command("git.discardAll", "Discard All Changes", discardAll);
      command("git.openChanges", "Open Changes", () => diff());
      command("git.checkout", "Checkout Existing Branch", () => checkout());
      command("git.clone", "Clone Repository", clone);
      command("git.cancelClone", "Cancel Clone", () =>
        cloneController?.abort(),
      );
      let failures = 0,
        timer: ReturnType<typeof setTimeout> | undefined,
        fetchController: AbortController | undefined,
        enabled = o.kernel.configuration.get("scm.autoFetch") === true;
      const schedule = () => {
        clearTimeout(timer);
        if (disposed || !enabled || !o.runtime?.connected || failures >= 3)
          return;
        timer = setTimeout(
          () => {
            fetchController = new AbortController();
            void request("fetch", {}, fetchController.signal)
              .then(
                () => {
                  failures = 0;
                  void refresh().catch(() => {});
                },
                (failure) => {
                  if (!fetchController?.signal.aborted) {
                    failures++;
                    if (failures === 3) {
                      error = `Auto-fetch stopped after three failures: ${String(failure)}`;
                      changed();
                    }
                  }
                },
              )
              .finally(() => {
                fetchController = undefined;
                schedule();
              });
          },
          Math.min(60000 * 2 ** failures, 300000),
        );
      };
      ctx.subscribe(
        o.kernel.configuration.subscribe(() => {
          const next = o.kernel.configuration.get("scm.autoFetch") === true;
          if (next !== enabled) {
            enabled = next;
            failures = 0;
            fetchController?.abort();
            schedule();
          }
        }),
      );
      if (o.runtime) {
        ctx.subscribe(
          o.runtime.subscribe("connection.change", (params) => {
            if (params.state === "connected") {
              failures = 0;
              schedule();
              void refresh().catch(() => {});
            } else {
              clearTimeout(timer);
              fetchController?.abort();
            }
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("operation.recovered", (operation) => {
            if (!operation.method?.startsWith("git.")) return;
            if (operation.status === "completed") {
              o.workbench.notify(
                `${operation.method}: operation completed after reconnect`,
              );
              void refresh().catch(() => {});
            } else if (
              ["failed", "interrupted", "unknown"].includes(operation.status)
            )
              o.workbench.notify(
                operation.error?.message ??
                  `${operation.method}: ${operation.status}; inspect repository state before retrying`,
                "warning",
              );
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("git.progress", (params) => {
            progress = (progress + (params.data ?? params.message ?? "")).slice(
              -8192,
            );
            changed();
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("fs.change", () => {
            if (o.kernel.context.get("gitRepo")) {
              clearTimeout(refreshTimer);
              refreshTimer = setTimeout(
                () => void refresh().catch(() => {}),
                300,
              );
            }
          }),
        );
      }
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      ctx.own(ctx.events.on("document.change", changed));
      if (typeof window !== "undefined") {
        const onFocus = () => {
          if (o.runtime?.connected) void refresh().catch(() => {});
        };
        window.addEventListener("focus", onFocus);
        ctx.subscribe(() => window.removeEventListener("focus", onFocus));
      }
      schedule();
      ctx.subscribe(() => {
        disposed = true;
        clearTimeout(timer);
        clearTimeout(refreshTimer);
        fetchController?.abort();
        cloneController?.abort();
        operationController?.abort();
        listeners.clear();
      });
    },
  };
}
