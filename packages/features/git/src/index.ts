import {
  Icon,
  IconButton,
  Select,
  FileBadge,
  translate as tr,
  displayShortcut,
  usePhone,
  useTouch,
} from "@oxbit/ui";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  Extension,
  FeatureOptions,
  GitBranchDiff,
  GitChange as Change,
  GitStatus as Status,
  GitDiff,
  GitLog,
  GitStash,
} from "@oxbit/sdk";
import {
  AI_SERVICE_ID,
  cleanCommitMessage,
  collectDiffs,
  commitMessagePrompt,
  commitPlanPrompt,
  parseCommitPlan,
  parsePullRequest,
  pullRequestPrompt,
  pullRequestRemote,
  type AiCompletion,
  type PlannedCommit,
} from "./ai.js";
import { CommitPlanDialog } from "./commit-plan.js";
import { CommitPlanError, partiallyStaged, runCommitPlan } from "./plan-runner.js";
import { PullRequestDialog } from "./pull-request.js";
import {
  History,
  Branches,
  Stashes,
  CommitDetails,
  StashDetails,
  Patch,
  type RepositoryUI,
} from "./views.js";
const CREATE_BRANCH = "\0create-branch",
  MANAGE_BRANCHES = "\0manage-branches";
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
const messageOf = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);
const AI_MISSING = "Set up an AI provider to use AI in Source Control";
export function createFeature(o: FeatureOptions): Extension {
  const git = o.git ?? o.runtime;
  let status: Status = emptyStatus(),
    error = "",
    progress = "",
    cloning = false,
    disposed = false;
  let revision = 0;
  let commitMessage = "",
    committing = false;
  let aiController: AbortController | undefined,
    aiTask: "message" | "plan" | undefined,
    aiFailure = "";
  let dialog:
    | { kind: "plan"; plan: PlannedCommit[] }
    | { kind: "pullRequest"; title: string }
    | undefined;
  type Section = "commits" | "branches" | "stashes";
  const sections = new Set<Section>();
  let scope: "all" | "staged" = "all";
  const showSection = (section: Section) => {
    sections.add(section);
    o.workbench.openPanel("scm");
    changed();
  };
  let view: "list" | "tree" | undefined;
  const currentView = () =>
    (view ??=
      typeof localStorage !== "undefined" &&
      localStorage.getItem("oxbit.scm.view") === "tree"
        ? "tree"
        : "list");
  const setView = (next: "list" | "tree") => {
    view = next;
    localStorage.setItem("oxbit.scm.view", next);
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
    if (!git?.connected)
      return Promise.reject(
        new Error(
          o.git
            ? "Source control is unavailable for this workspace"
            : "Connect to a trusted runtime workspace to use Git",
        ),
      );
    return git.request<T>("git." + method, params, { signal });
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
      o.kernel.context.set("gitAmend", canAmend());
      o.kernel.context.set("gitPullRequest", canPullRequest());
      changed();
    } catch (failure) {
      if (sequence !== statusRequest || disposed) return;
      status = emptyStatus();
      error = String(failure);
      o.kernel.context.set("gitRepo", false);
      o.kernel.context.set("gitChanges", false);
      o.kernel.context.set("gitStaged", false);
      o.kernel.context.set("gitAmend", false);
      o.kernel.context.set("gitPullRequest", false);
      changed();
      throw failure;
    }
  };
  // The iOS on-device client (o.git) has no amend or pull request support.
  const runtimeHost = () => !o.git && !!o.runtime;
  const canAmend = () => runtimeHost() && !!status.head;
  const canPullRequest = () =>
    runtimeHost() &&
    !!status.head &&
    status.branches.includes(status.branch) &&
    !!pullRequestRemote(status);
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
    if (!(await saveBuffers(undefined, true))) return false;
    if (status.changes.some((change) => change.conflict))
      throw new Error(
        "Resolve and stage conflicted files individually before staging all changes",
      );
    await request("stageAll");
    await refresh();
    return true;
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
  const commit = async (message?: string, method = "commit") => {
    if (committing) return false;
    message ??=
      commitMessage || (await o.workbench.prompt(tr("Commit message")));
    if (message === undefined) return false;
    if (!message.trim() && method === "commit")
      throw new Error("Enter a commit message");
    committing = true;
    changed();
    try {
      await request(method, { message });
      if (commitMessage === message) commitMessage = "";
      await refresh();
      o.workbench.notify(
        tr(method === "amend" ? "Last commit amended" : "Commit created"),
      );
      return true;
    } finally {
      committing = false;
      changed();
    }
  };
  const pushOrPublish = async () => {
    if (status.upstream) return perform("push");
    const remote =
      pullRequestRemote(status) ??
      (status.remotes.length === 1 ? status.remotes[0]!.name : undefined);
    if (!remote) {
      showSection("branches");
      return false;
    }
    return perform("publish", { remote });
  };
  /** Commits staged changes, or stages everything first when nothing is staged. */
  const commitChanges = async ({ push = false } = {}) => {
    await refresh();
    if (status.changes.some((change) => change.conflict))
      throw new Error("Resolve conflicts before committing");
    const message = commitMessage.trim()
      ? commitMessage
      : await o.workbench.prompt(tr("Commit message"));
    if (message === undefined) return false;
    if (!status.changes.some(staged)) {
      if (!status.changes.length) throw new Error("There are no changes to commit");
      if (!(await stageAll())) return false;
    }
    if (!(await commit(message))) return false;
    if (push) await pushOrPublish();
    return true;
  };
  const amend = async () => {
    await refresh();
    if (!canAmend()) throw new Error("This workspace cannot amend commits");
    if (
      status.upstream &&
      !status.ahead &&
      (await o.workbench.ask(
        tr("Amend pushed commit?"),
        tr("The last commit is already on {0}. Amending it rewrites history you have pushed.", {
          "0": status.upstream,
        }),
        ["Amend Last Commit", "Cancel"],
        true,
      )) !== "Amend Last Commit"
    )
      return false;
    return commit(commitMessage, "amend");
  };
  const sync = async () => {
    if (await perform("pull", runtimeHost() ? { rebase: true } : {}))
      await perform("push");
  };
  const aiService = () =>
    o.kernel.services.optional<AiCompletion>(AI_SERVICE_ID);
  const aiUnavailable = () =>
    aiFailure || (aiService() ? undefined : tr(AI_MISSING));
  /** Runs one AI task at a time; AI service errors disable AI actions until settings change. */
  const withAi = async <T>(
    task: "message" | "plan",
    work: (ai: AiCompletion, signal: AbortSignal) => Promise<T>,
  ) => {
    const ai = aiService();
    if (!ai) {
      error = tr(AI_MISSING);
      changed();
      return undefined;
    }
    if (aiController) throw new Error("Wait for the current AI request to finish");
    const controller = (aiController = new AbortController());
    aiTask = task;
    error = "";
    changed();
    const guarded: AiCompletion = {
      complete: (input, signal) =>
        ai.complete(input, signal).catch((failure: unknown) => {
          if (!signal?.aborted) aiFailure = messageOf(failure);
          throw failure;
        }),
    };
    try {
      return await work(guarded, controller.signal);
    } catch (failure) {
      if (controller.signal.aborted) return undefined;
      error = messageOf(failure);
      return undefined;
    } finally {
      aiController = undefined;
      aiTask = undefined;
      changed();
    }
  };
  const recentSubjects = async (signal: AbortSignal) =>
    status.head
      ? (await request<GitLog>("log", { limit: 10 }, signal)).commits.map(
          (commit) => commit.subject,
        )
      : [];
  const generateMessage = () =>
    withAi("message", async (ai, signal) => {
      await refresh();
      const hasStaged = status.changes.some(staged);
      const changes = status.changes.filter((change) =>
        hasStaged ? staged(change) : !change.conflict,
      );
      if (!changes.length) throw new Error("There are no changes to describe");
      const [files, subjects] = await Promise.all([
        collectDiffs(request, changes, hasStaged ? "staged" : "all", signal),
        recentSubjects(signal),
      ]);
      const text = await ai.complete(commitMessagePrompt(files, subjects), signal);
      if (!signal.aborted) commitMessage = cleanCommitMessage(text);
    });
  const commitWithAi = () =>
    withAi("plan", async (ai, signal) => {
      await refresh();
      if (status.changes.some((change) => change.conflict))
        throw new Error("Resolve conflicts before committing with AI");
      if (!status.changes.length) throw new Error("There are no changes to commit");
      const [files, subjects] = await Promise.all([
        collectDiffs(request, status.changes, "all", signal),
        recentSubjects(signal),
      ]);
      const text = await ai.complete(commitPlanPrompt(files, subjects), signal);
      if (signal.aborted) return;
      dialog = {
        kind: "plan",
        plan: parseCommitPlan(text, status.changes),
      };
      o.workbench.openPanel("scm");
    });
  const runPlan = async (plan: PlannedCommit[], step: (index: number) => void) => {
    if (!(await saveBuffers(undefined, true))) throw new Error(tr("Commit cancelled"));
    try {
      await refresh();
      try {
        await runCommitPlan({
          request,
          changes: status.changes,
          plan,
          preserveIndex: runtimeHost(),
          step,
        });
      } catch (failure) {
        if (!(failure instanceof CommitPlanError)) throw failure;
        throw new Error(
          tr("Commit {0} of {1} failed: {2}", {
            "0": failure.index + 1,
            "1": plan.length,
            "2": failure.message,
          }),
        );
      }
      commitMessage = "";
      o.workbench.notify(tr("{0} commits created", { "0": plan.length }));
    } finally {
      await refresh().catch(() => {});
      await o.workbench.refreshFiles();
    }
  };
  const openPullRequest = async () => {
    await refresh();
    if (!canPullRequest())
      throw new Error("Draft pull requests need a github.com remote and a runtime workspace");
    dialog = {
      kind: "pullRequest",
      title: status.refs.find((ref) => ref.current)?.subject ?? "",
    };
    o.workbench.openPanel("scm");
    changed();
  };
  const generatePullRequest = async (signal: AbortSignal) => {
    const ai = aiService();
    if (!ai) throw new Error(tr(AI_MISSING));
    const diff = await request<GitBranchDiff>("branchDiff", {}, signal);
    if (!("base" in diff)) throw new Error("Open a Git repository first");
    const commits = (await request<GitLog>("log", { base: diff.base, limit: 50 }, signal)).commits.map(
      (commit) => (commit.body ? `${commit.subject}\n  ${commit.body.replace(/\n/g, "\n  ")}` : commit.subject),
    );
    const files = diff.files.map((file) => ({
      path: file.path,
      status: "M",
      diff: file.binary ? "(binary file changed)" : file.diff,
    }));
    const text = await ai
      .complete(pullRequestPrompt({ base: diff.base, head: diff.head, commits, files }), signal)
      .catch((failure: unknown) => {
        if (!signal.aborted) {
          aiFailure = messageOf(failure);
          changed();
        }
        throw failure;
      });
    return parsePullRequest(text);
  };
  const createPullRequest = async (
    title: string,
    body: string,
    step: (message: string) => void,
  ) => {
    await refresh();
    const remote = pullRequestRemote(status);
    if (!remote) throw new Error("Add a github.com remote to create a pull request");
    if (!status.upstream) {
      step(tr("Publishing branch…"));
      await perform("publish", { remote });
    } else if (status.ahead > 0) {
      step(tr("Pushing commits…"));
      await perform("push");
    }
    step(tr("Creating draft pull request…"));
    return (await request<{ url: string }>("createPullRequest", { title, body })).url;
  };
  let branchOpenRequest = 0;
  const checkout = async (branch?: string) => {
    await refresh();
    if (!branch) {
      branchOpenRequest++;
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
    o.kernel.context.set("gitCloning", true);
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
        : o.git
          ? "Clone failed."
          : "Clone failed. Runtime credential helpers supply authentication.";
      throw failure;
    } finally {
      cloning = false;
      o.kernel.context.set("gitCloning", false);
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
    const view = currentView();
    const touch = useTouch() || usePhone();
    const root = useRef<HTMLDivElement>(null);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [pending, setPending] = useState(false);
    const [filter, setFilter] = useState("");
    const [filtering, setFiltering] = useState(false);
    const [stashCount, setStashCount] = useState(0);
    useEffect(() => {
      if (!status.repository) {
        setStashCount(0);
        return;
      }
      const controller = new AbortController();
      request<GitStash[]>("stashes", {}, controller.signal).then(
        (list) => {
          if (!controller.signal.aborted) setStashCount(list.length);
        },
        () => {},
      );
      return () => controller.abort();
    }, [revision, status.repository]);
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
    const commitAll = !hasStaged && status.changes.length > 0;
    const canCommit =
      (hasStaged || commitAll) &&
      !pending &&
      !committing &&
      !status.changes.some((change) => change.conflict);
    const submit = () => {
      if (canCommit) run(() => commitChanges());
    };
    const aiOff = aiUnavailable();
    const commitMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      o.workbench.showContextMenu("scm.commit", rect.left, rect.bottom, [
        "git.commitAndPush",
        "git.commitWithAi",
        ...(canPullRequest() ? ["git.createPullRequest"] : []),
        ...(canAmend() ? ["git.amend"] : []),
      ]);
    };
    const syncButtons = !status.repository
      ? []
      : !status.upstream
        ? [
            h(IconButton, {
              key: "publish",
              className: "icon-button scm-sync",
              icon: "cloud",
              label: "Publish branch",
              disabled: pending || !status.head,
              onClick: () => run(pushOrPublish),
            }),
          ]
        : status.ahead && status.behind && runtimeHost()
          ? [
              h(IconButton, {
                key: "sync",
                className: "icon-button scm-sync",
                icon: "sync",
                label: "Sync",
                title: tr("Pull {0} and push {1} commits", {
                  "0": status.behind,
                  "1": status.ahead,
                }),
                disabled: pending,
                onClick: () => run(sync),
              }),
            ]
          : [
              h(IconButton, {
                key: "pull",
                className: "icon-button scm-sync",
                icon: "arrowDown",
                label: "Pull",
                disabled: pending,
                onClick: () => run(() => perform("pull")),
              }),
              h(IconButton, {
                key: "push",
                className: "icon-button scm-sync",
                icon: "arrowUp",
                label: "Push",
                disabled: pending || !status.head,
                onClick: () => run(() => perform("push")),
              }),
            ];
    const modal =
      dialog?.kind === "plan"
        ? h(CommitPlanDialog, {
            plan: dialog.plan,
            run: runPlan,
            partial: runtimeHost()
              ? []
              : status.changes.filter(partiallyStaged).map((change) => change.path),
            onClose: () => {
              dialog = undefined;
              changed();
            },
          })
        : dialog?.kind === "pullRequest"
          ? h(PullRequestDialog, {
              title: dialog.title,
              aiUnavailable: aiOff,
              generate: generatePullRequest,
              create: createPullRequest,
              onClose: () => {
                dialog = undefined;
                changed();
              },
            })
          : null;
    const statusBadge = (code: string) =>
      code === "?"
        ? h(
            "span",
            {
              className: "scm-status",
              "data-status": code,
              title: tr("Untracked"),
              "aria-label": tr("Untracked"),
            },
            "U",
          )
        : h("span", { className: "scm-status", "data-status": code }, code);
    const counts = (change: Change, group: string) =>
      group === "staged"
        ? change.staged
        : group === "unstaged"
          ? change.unstaged
          : undefined;
    const lineStat = (
      value: { added: number; removed: number } | undefined,
      className = "scm-stat",
    ) =>
      value &&
      (value.added || value.removed) &&
      h(
        "span",
        {
          className,
          "aria-label": tr("{0} added, {1} removed", {
            "0": value.added,
            "1": value.removed,
          }),
        },
        value.added ? h("span", { className: "scm-added" }, "+" + value.added) : null,
        value.removed
          ? h("span", { className: "scm-removed" }, "−" + value.removed)
          : null,
      );
    const overflow = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const available = (id: string) =>
        o.kernel.commands.available(id).enabled;
      const contributed = o.kernel.contributions
        .list("toolbar")
        .filter(
          (item) =>
            item.location === "sidebar:scm" &&
            item.command &&
            o.kernel.context.matches(item.when),
        )
        .map((item) => item.command!);
      const ids = [
        "git.refresh",
        "git.fetch",
        "git.pull",
        status.upstream || !status.repository ? "git.push" : "git.publish",
        ...(status.ahead && status.behind && runtimeHost() ? ["git.sync"] : []),
        "git.clone",
        ...(available("git.account") ? ["git.account"] : []),
        "-",
        "git.stashSave",
        "git.stashSaveTracked",
        "git.stashes",
        "-",
        "git.branchCreate",
        "git.branches",
        "git.history",
        view === "list" ? "git.viewTree" : "git.viewList",
        ...(contributed.length ? ["-", ...contributed] : []),
        ...(o.workbench.movePanel
          ? ["-", "git.moveLeft", "git.moveRight", "git.moveBottom"]
          : []),
      ];
      o.workbench.showContextMenu("scm.toolbar", rect.left, rect.bottom, ids);
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
          style: { paddingLeft: 24 + depth * 12 },
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
        lineStat(counts(change, group)),
        statusBadge(isStaged ? change.index : change.working),
        h(
          "div",
          { className: "scm-file-actions" },
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
                  style: { paddingLeft: 22 + depth * 12 },
                  onClick: () => toggle(key),
                },
                h(Icon, { name: expanded ? "chevD" : "chevR", size: 14 }),
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
    const groups = (
      scope === "staged"
        ? (["conflicts", "staged"] as const)
        : (["conflicts", "staged", "unstaged"] as const)
    ).map((group) => {
      const all = status.changes.filter(
        group === "conflicts"
          ? (change) => change.conflict
          : group === "staged"
            ? staged
            : unstaged,
      );
      return {
        group,
        all,
        changes: all.filter((change) =>
          change.path.toLowerCase().includes(filter.toLowerCase()),
        ),
      };
    });
    const total = groups.reduce(
      (sum, { group, all }) => {
        for (const change of all) {
          const value = counts(change, group);
          sum.added += value?.added ?? 0;
          sum.removed += value?.removed ?? 0;
        }
        return sum;
      },
      { added: 0, removed: 0 },
    );
    const groupTitle = (group: string) =>
      group === "conflicts"
        ? tr("Merge changes")
        : group === "staged"
          ? tr("Staged")
          : tr("Changes");
    const section = (
      id: Section,
      title: string,
      body: () => React.ReactNode,
      aside?: React.ReactNode,
    ) => {
      const open = sections.has(id);
      return h(
        "section",
        {
          key: id,
          className: "scm-section",
          "data-open": open,
          "aria-label": tr(title),
        },
        h(
          "button",
          {
            className: "scm-heading scm-section-toggle",
            "aria-expanded": open,
            onClick: () => {
              if (open) sections.delete(id);
              else sections.add(id);
              changed();
            },
          },
          h(Icon, { name: open ? "chevD" : "chevR", size: 14 }),
          h("span", null, tr(title)),
          aside,
        ),
        open && h("div", { className: "scm-section-body" }, body()),
      );
    };
    return h(
      "div",
      {
        ref: root,
        className: "scm-panel",
        "data-touch": touch || undefined,
        onContextMenu: (event: React.MouseEvent) => {
          event.preventDefault();
          o.workbench.showContextMenu("scm", event.clientX, event.clientY);
        },
      },
      modal &&
        createPortal(modal, root.current?.closest(".workbench") ?? document.body),
      h(
        "div",
        { className: "scm-toolbar" },
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
          options: [
            ...[...new Set([status.branch, ...status.branches])].map(
              (branch) => ({
                value: branch,
                label: branch || tr("No repository"),
                disabled: !status.branches.includes(branch),
              }),
            ),
            { value: CREATE_BRANCH, label: tr("Create branch…") },
            { value: MANAGE_BRANCHES, label: tr("Manage branches and remotes…") },
          ],
          onChange: (branch) => {
            if (branch === CREATE_BRANCH)
              run(() => o.kernel.commands.execute("git.branchCreate"));
            else if (branch === MANAGE_BRANCHES) {
              sections.add("branches");
              changed();
            } else if (branch !== status.branch) run(() => checkout(branch));
          },
        }),
        status.upstream &&
          h(
            "span",
            {
              className: "scm-tracking",
              role: "status",
              title: status.upstream,
              "aria-label": tr("{0}: {1} ahead, {2} behind", {
                "0": status.upstream,
                "1": status.ahead,
                "2": status.behind,
              }),
            },
            status.ahead ? "↑" + status.ahead : "",
            status.ahead && status.behind ? " " : "",
            status.behind ? "↓" + status.behind : "",
          ),
        h("span", { className: "scm-toolbar-spacer" }),
        ...syncButtons,
        status.repository &&
          h(
            "div",
            { className: "scm-commit-split" },
            h(
              "button",
              {
                className: "button scm-commit",
                disabled: !canCommit,
                "data-tooltip": commitAll
                  ? tr("Stage all changes and commit")
                  : `${tr("Commit")} (${displayShortcut("Mod+Enter")})`,
                onClick: submit,
              },
              h(Icon, { name: "check", size: 14 }),
              h("span", { className: "scm-commit-label" }, tr(commitAll ? "Commit All" : "Commit")),
            ),
            h(
              "button",
              {
                className: "button scm-commit-menu",
                "aria-label": tr("More commit actions"),
                "data-tooltip": tr("More commit actions"),
                "aria-haspopup": "menu",
                disabled: pending || committing || !!aiTask,
                onClick: commitMenu,
              },
              h(Icon, { name: "chevD", size: 14 }),
            ),
          ),
        h(IconButton, {
          icon: "more",
          label: "Source control actions",
          "aria-haspopup": "menu",
          onClick: overflow,
        }),
      ),
      !status.branch &&
        h(
          "div",
          { className: "scm-compose" },
          h(
            "button",
            {
              className: "button",
              disabled: pending || !git?.connected,
              onClick: () => run(() => request("init").then(refresh)),
            },
            h(Icon, { name: "plus" }),
            tr("Initialize Repository"),
          ),
        ),
      status.repository &&
        h(
          "div",
          { className: "scm-scope" },
          h(Select, {
            className: "scm-scope-select",
            label: tr("Changes shown"),
            value: scope,
            options: [
              { value: "all", label: tr("Uncommitted") },
              { value: "staged", label: tr("Staged") },
            ],
            onChange: (value) => {
              scope = value === "staged" ? "staged" : "all";
              changed();
            },
          }),
          lineStat(total, "scm-stat scm-total"),
          h("span", { className: "scm-toolbar-spacer" }),
          h(IconButton, {
            icon: "search",
            label: "Filter changed files",
            "aria-pressed": filtering,
            onClick: () => {
              if (filtering) setFilter("");
              setFiltering(!filtering);
            },
          }),
          h(IconButton, {
            icon: view === "list" ? "folder" : "menu",
            label: view === "list" ? "Switch to tree view" : "Switch to list view",
            onClick: () => setView(view === "list" ? "tree" : "list"),
          }),
          h(IconButton, {
            icon: "refresh",
            label: "Refresh Source Control",
            disabled: pending,
            onClick: () => run(refresh),
          }),
        ),
      status.repository &&
        filtering &&
        h(
          "div",
          { className: "scm-filter-row" },
          h("input", {
            className: "scm-filter",
            "aria-label": tr("Filter changed files"),
            placeholder: tr("Filter changed files"),
            autoFocus: true,
            value: filter,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              setFilter(event.target.value),
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Escape") {
                setFilter("");
                setFiltering(false);
              }
            },
          }),
        ),
      status.repository &&
        h(
          "div",
          { className: "scm-message-box" },
          h("textarea", {
            className: "scm-message",
            "aria-label": tr("Commit message"),
            rows: 1,
            placeholder: tr("Commit message"),
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
          h(IconButton, {
            icon: aiTask === "message" ? "stop" : "agent",
            label:
              aiTask === "message"
                ? "Stop generating commit message"
                : "Generate commit message",
            title: aiTask === "message" ? undefined : aiOff,
            "aria-busy": aiTask === "message",
            // aria-disabled keeps pointer events so the tooltip explains why AI is off.
            "aria-disabled": !aiTask && !!aiOff ? true : undefined,
            disabled:
              aiTask !== "message" && (!!aiTask || !status.changes.length),
            onClick: () =>
              aiTask === "message"
                ? aiController?.abort()
                : !aiOff && report(generateMessage),
          }),
        ),
      (aiTask === "plan" ||
        error ||
        progress ||
        operationController ||
        cloning) &&
        h(
          "div",
          { className: "scm-compose" },
          aiTask === "plan" &&
            h(
              "div",
              { className: "scm-ai-status", role: "status" },
              h("span", null, tr("Planning commits with AI…")),
              h(
                "button",
                { className: "button", onClick: () => aiController?.abort() },
                tr("Cancel"),
              ),
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
          { className: "scm-content", id: "scm-content" },
          h(
            "div",
            { className: "scm-changes" },
            ...groups.map(({ group, all, changes }) => {
              if (group === "conflicts" && !all.length) return null;
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
                      className: "scm-heading scm-group-toggle",
                      "aria-expanded": expanded,
                      onClick: () => toggle(group),
                    },
                    h(Icon, {
                      name: expanded ? "chevD" : "chevR",
                      size: 14,
                    }),
                    h("span", null, groupTitle(group)),
                    h("span", { className: "scm-count" }, changes.length),
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
            }),
            !status.changes.length &&
              !error &&
              h(
                "div",
                { className: "scm-empty" },
                h(Icon, { name: "okCircle", size: 16 }),
                h("span", null, tr("No changes")),
              ),
          ),
          (stashCount > 0 || sections.has("stashes")) &&
            section(
              "stashes",
              "Stashes",
              () => h(Stashes, { api, pending, revision, run }),
              stashCount > 0 && h("span", { className: "scm-count" }, stashCount),
            ),
          section("branches", "Branches", () =>
            h(Branches, { api, status, pending, run }),
          ),
          section("commits", "Commits", () =>
            h(History, { api, status, revision }),
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
          loaded: () => revision > 0 || error !== "",
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
          data: { phoneHeader: false },
        }),
      );
      const command = (
        id: string,
        title: string,
        run: (args?: any) => unknown,
        when?: string,
      ) => ctx.own(ctx.commands.register({ id, title, run, when }));
      command("git.restore", "Restore Missing File from Git", (args) =>
        restore(args?.path),
      );
      command("git.compare", "Compare Buffer with Disk", compare);
      command("git.refresh", "Refresh Source Control", refresh);
      command("git.init", "Initialize Repository", () =>
        request("init").then(refresh),
      );
      command("git.commit", "Commit Staged Changes", () => commit());
      command("git.commitAll", "Commit All", () => commitChanges());
      command("git.commitAndPush", "Commit and Push", () =>
        commitChanges({ push: true }),
      );
      command("git.commitWithAi", "Commit with AI…", commitWithAi);
      command("git.generateCommitMessage", "Generate Commit Message", generateMessage);
      command("git.amend", "Amend Last Commit", amend, "gitAmend");
      command(
        "git.createPullRequest",
        "Create Draft Pull Request…",
        openPullRequest,
        "gitPullRequest",
      );
      command("git.sync", "Sync (Pull and Push)", sync);
      command("git.push", "Push", () =>
        status.upstream ? perform("push") : showSection("branches"),
      );
      command("git.fetch", "Fetch", () => perform("fetch"));
      command("git.pull", "Pull (Fast-forward Only)", () => perform("pull"));
      command("git.history", "Show Commit History", () =>
        showSection("commits"),
      );
      command("git.branches", "Manage Branches and Remotes", () =>
        showSection("branches"),
      );
      command("git.stashes", "Manage Stashes", () => showSection("stashes"));
      const stashSave = async (includeUntracked: boolean) => {
        const message = (await o.workbench.prompt(tr("Stash message")))?.trim();
        if (!message) return;
        if (await perform("stashSave", { message, includeUntracked }))
          showSection("stashes");
      };
      command("git.stashSave", "Stash Changes…", () => stashSave(true));
      command("git.stashSaveTracked", "Stash Tracked Changes…", () =>
        stashSave(false),
      );
      command("git.branchCreate", "Create Branch", async () => {
        const name = await o.workbench.prompt(tr("New branch name"));
        if (name) await perform("branchCreate", { name });
      });
      command("git.publish", "Publish Branch", pushOrPublish);
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
      command(
        "git.cancelClone",
        "Cancel Clone",
        () => cloneController?.abort(),
        "gitCloning",
      );
      command("git.viewTree", "Switch to tree view", () => setView("tree"));
      command("git.viewList", "Switch to list view", () => setView("list"));
      for (const [id, title, container] of [
        ["git.moveLeft", "Move Source Control to Left", "left"],
        ["git.moveRight", "Move Source Control to Right", "right"],
        ["git.moveBottom", "Move Source Control to Bottom", "bottom"],
      ] as const)
        command(id, title, () => o.workbench.movePanel?.("scm", { container }));
      let failures = 0,
        timer: ReturnType<typeof setTimeout> | undefined,
        fetchController: AbortController | undefined,
        enabled = o.kernel.configuration.get("scm.autoFetch") === true;
      const schedule = () => {
        clearTimeout(timer);
        if (disposed || !enabled || !git?.connected || failures >= 3)
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
          if (aiFailure) {
            aiFailure = "";
            changed();
          }
          const next = o.kernel.configuration.get("scm.autoFetch") === true;
          if (next !== enabled) {
            enabled = next;
            failures = 0;
            fetchController?.abort();
            schedule();
          }
        }),
      );
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      const filesystemChanged = () => {
        if (o.kernel.context.get("gitRepo")) {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(
            () => void refresh().catch(() => {}),
            300,
          );
        }
      };
      if (git) {
        ctx.subscribe(
          git.subscribe("connection.change", (params) => {
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
          git.subscribe("operation.recovered", (operation) => {
            if (!operation.method?.startsWith("git.")) return;
            if (operation.status === "completed") {
              o.workbench.notify(
                `${operation.method}: operation completed after reconnect`,
              );
              void refresh().catch(() => {});
            } else if (
              ["failed", "interrupted", "unknown", "expired"].includes(operation.status)
            )
              o.workbench.notify(
                operation.error?.message ??
                  `${operation.method}: ${operation.status}; inspect repository state before retrying`,
                "warning",
              );
          }),
        );
        ctx.subscribe(
          git.subscribe("git.progress", (params) => {
            progress = (progress + (params.data ?? params.message ?? "")).slice(
              -8192,
            );
            changed();
          }),
        );
      }
      if (o.git) ctx.own(o.filesystem.watch(filesystemChanged));
      else if (o.runtime)
        ctx.subscribe(o.runtime.subscribe("fs.change", filesystemChanged));
      ctx.own(ctx.events.on("document.change", changed));
      if (typeof window !== "undefined") {
        const onFocus = () => {
          if (git?.connected) void refresh().catch(() => {});
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
        aiController?.abort();
        listeners.clear();
      });
    },
  };
}
