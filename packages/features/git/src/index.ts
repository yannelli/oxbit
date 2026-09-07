import { translate as tr } from "@oxbit/ui";
import React, { useEffect, useState } from "react";
import type { Extension, FeatureOptions } from "@oxbit/sdk";
type Change = { path: string; index: string; working: string };
type Status = { branch: string; branches: string[]; changes: Change[] };
export function resolveConflict(
  text: string,
  choice: "current" | "incoming" | "both",
): string {
  return text.replace(
    /^<<<<<<<[^\n]*\n([\s\S]*?)^=======[^\n]*\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm,
    (_match, current: string, incoming: string) =>
      choice === "current"
        ? current
        : choice === "incoming"
          ? incoming
          : current + incoming,
  );
}
export function unifiedDiff(before:string,after:string):string {
  if(before===after)return "No changes";
  const left=before.split("\n"),right=after.split("\n"),lines=["--- Previous content","+++ Current content"];
  let prefix=0;while(prefix<left.length&&prefix<right.length&&left[prefix]===right[prefix])prefix++;
  let suffix=0;while(suffix<left.length-prefix&&suffix<right.length-prefix&&left[left.length-1-suffix]===right[right.length-1-suffix])suffix++;
  const a=left.slice(prefix,left.length-suffix),b=right.slice(prefix,right.length-suffix);
  lines.push(`@@ -${prefix+1},${a.length} +${prefix+1},${b.length} @@`);
  if(a.length*b.length>1000000){lines.push(...a.map(line=>"-"+line),...b.map(line=>"+"+line));return lines.join("\n");}
  const width=b.length+1,table=new Uint32Array((a.length+1)*width);
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i*width+j]=a[i]===b[j]?1+table[(i+1)*width+j+1]:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
  let i=0,j=0;while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){lines.push(" "+a[i++]);j++;}else if(j<b.length&&(i===a.length||table[i*width+j+1]>table[(i+1)*width+j]))lines.push("+"+b[j++]);else lines.push("-"+a[i++]);}
  return lines.join("\n");
}
const staged = (change: Change) => ![" ", "?", ""].includes(change.index);
const unstaged = (change: Change) => ![" ", ""].includes(change.working);
export function createFeature(o: FeatureOptions): Extension {
  let status: Status = { branch: "", branches: [], changes: [] },
    error = "",
    progress = "",
    cloning = false,
    disposed = false;
  const listeners = new Set<() => void>();
  let cloneController: AbortController | undefined;
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const request = <T = any>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) => {
    if (!o.runtime?.connected)
      throw new Error("Connect to a trusted runtime workspace to use Git");
    return o.runtime.request<T>("git." + method, params, { signal });
  };
  const refresh = async () => {
    try {
      status = await request<Status>("status");
      status.changes ??= [];
      status.branches ??= [];
      error = "";
      o.kernel.context.set("gitRepo", true);
      o.kernel.context.set("gitChanges", status.changes.length > 0);
      o.kernel.context.set("gitStaged", status.changes.some(staged));
      changed();
    } catch (failure) {
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
    message ??= await o.workbench.prompt(tr("Commit message"));
    if (message === undefined) return;
    if (!message.trim()) throw new Error("Enter a commit message");
    await request("commit", { message });
    await refresh();
    o.workbench.notify("Commit created");
  };
  const checkout = async (branch?: string) => {
    await refresh();
    branch ??= await o.workbench.prompt(
      "Existing branch: " + status.branches.join(", "),
      status.branch,
    );
    if (!branch) return;
    if (!status.branches.includes(branch))
      throw new Error("Choose an existing local branch");
    await request("checkout", { branch });
    await refresh();
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
    const [data, setData] = useState<{
        before: string;
        after: string;
        diff: string;
      }>(),
      [failure, setFailure] = useState(""),
      [inline, setInline] = useState(
        o.kernel.configuration.get("scm.diffLayout") === "inline",
      );
    const [, render] = useState(0);
    useEffect(() => {
      const controller = new AbortController();
      const load = mode
        ? (async () => {
            const document = await o.documents.open(path),
              before =
                mode === "base"
                  ? document.savedText
                  : (o.runtime && o.filesystem.id.startsWith("runtime:") ? await o.runtime.request<{text:string}>("fs.read",{path}) : await o.filesystem.read(path)).text;
            return {
              before,
              after: document.text.toString(),
              diff: unifiedDiff(before,document.text.toString()),
            };
          })()
        : request("diff", { path, staged: isStaged }, controller.signal);
      void load.then(setData, (reason) => {
        if (!controller.signal.aborted) setFailure(String(reason));
      });
      const off = o.kernel.events.on("document.change", () =>
        render((value) => value + 1),
      );
      return () => {
        controller.abort();
        off.dispose();
      };
    }, [path, isStaged, mode]);
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
          { onClick: () => setInline(!inline) },
          inline ? tr("Side by side") : tr("Inline"),
        ),
        buffer?.dirty &&
          React.createElement(
            "button",
            { onClick: () => report(() => stage(path, true)) },
            tr("Save and Stage"),
          ),
      ),
      failure && React.createElement("p", { role: "alert" }, failure),
      data &&
        React.createElement(
          "div",
          { style: { display: "flex", flex: 1, overflow: "auto" } },
          ...(inline
            ? [data.diff || unifiedDiff(data.before,data.after)]
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
                  fontSize: 12,
                },
              },
              ...(inline ? text.split("\n").map((line,index)=>React.createElement("span",{key:index,style:{display:"block",background:line.startsWith("+")&&!line.startsWith("+++")?"var(--add-soft)":line.startsWith("-")&&!line.startsWith("---")?"var(--del-soft)":"transparent"}},line||" ")) : [text]),
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
    const [, render] = useState(0),
      [message, setMessage] = useState("");
    useEffect(() => {
      const listener = () => render((value) => value + 1);
      listeners.add(listener);
      void refresh().catch(() => {});
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return React.createElement(
      "div",
      {
        className: "scm-panel",
        onContextMenu:(event:React.MouseEvent)=>{event.preventDefault();o.workbench.showContextMenu("scm",event.clientX,event.clientY);},
        style: {
          height: "100%",
          padding: 12,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        },
      },
      React.createElement(
        "div",
        {
          className: "scm-actions",
          style: { display: "flex", gap: 6, flexWrap: "wrap" },
        },
        React.createElement(
          "button",
          { onClick: () => report(refresh) },
          tr("Refresh"),
        ),
        React.createElement(
          "button",
          {
            onClick: () =>
              report(async () => {
                await request("init");
                await refresh();
              }),
          },
          tr("Initialize"),
        ),
        React.createElement(
          "button",
          { onClick: () => report(() => request("push").then(refresh)) },
          tr("Push"),
        ),
        React.createElement(
          "button",
          { onClick: () => report(clone) },
          tr("Clone"),
        ),
      ),
      React.createElement(
        "select",
        {
          "aria-label": tr("Git branch"),
          value: status.branch,
          onChange: (event: any) => report(() => checkout(event.target.value)),
        },
        ...[...new Set([status.branch, ...status.branches])].map((branch) =>
          React.createElement(
            "option",
            { key: branch, value: branch },
            branch || tr("No repository"),
          ),
        ),
      ),
      React.createElement("textarea", {
        className: "scm-message",
        "aria-label": tr("Commit message"),
        rows: 3,
        placeholder: tr("Message (Ctrl+Enter to commit)"),
        value: message,
        onChange: (event: any) => setMessage(event.target.value),
        onKeyDown: (event: any) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            report(() => commit(message).then(() => setMessage("")));
          }
        },
      }),
      React.createElement(
        "button",
        {
          className: "btn primary",
          disabled: !status.changes.some(staged),
          onClick: () =>
            report(() => commit(message).then(() => setMessage(""))),
        },
        tr("Commit staged changes"),
      ),
      error &&
        React.createElement(
          "p",
          { role: "alert", style: { fontSize: 12, whiteSpace: "pre-wrap" } },
          error,
        ),
      progress &&
        React.createElement(
          "pre",
          {
            role: "status",
            style: {
              fontSize: 11,
              whiteSpace: "pre-wrap",
              maxHeight: 120,
              overflow: "auto",
            },
          },
          progress,
        ),
      cloning &&
        React.createElement(
          "button",
          { onClick: () => cloneController?.abort() },
          tr("Cancel Clone"),
        ),
      ...(["staged", "unstaged"] as const).map((group) => {
        const changes = status.changes.filter(
          group === "staged" ? staged : unstaged,
        );
        return React.createElement(
          "section",
          { key: group, className: "scm-group" },
          React.createElement(
            "h4",
            {
              style: {
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: ".04em",
                display: "flex",
                justifyContent: "space-between",
              },
            },
            group === "staged" ? tr("Staged changes") : tr("Changes"),
            React.createElement("span", null, changes.length),
          ),
          ...changes.map((change) =>
            React.createElement(
              "div",
              {
                key: change.path,
                className: "scm-file",
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  minHeight: 28,
                },
              },
              React.createElement(
                "button",
                {
                  style: {
                    flex: 1,
                    textAlign: "left",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                  onClick: () => diff(change.path, group === "staged"),
                },
                change.path + (o.documents.get(change.path)?.dirty ? " ●" : ""),
              ),
              React.createElement(
                "span",
                {
                  style: {
                    fontFamily: "var(--font-mono)",
                    color:
                      change.working === "?" ? "var(--add)" : "var(--accent)",
                  },
                },
                group === "staged" ? change.index : change.working,
              ),
              React.createElement(
                "button",
                {
                  "aria-label":
                    (group === "staged" ? "Unstage " : "Stage ") + change.path,
                  onClick: () =>
                    report(() =>
                      group === "staged"
                        ? request("unstage", { path: change.path }).then(
                            refresh,
                          )
                        : stage(change.path),
                    ),
                },
                group === "staged" ? "−" : "+",
              ),
              group === "unstaged" &&
                React.createElement(
                  "button",
                  {
                    "aria-label": "Discard " + change.path,
                    onClick: () => report(() => discard(change.path)),
                  },
                  "↶",
                ),
              o.documents.get(change.path)?.dirty &&
                React.createElement(
                  "button",
                  { onClick: () => report(() => stage(change.path, true)) },
                  tr("Save and Stage"),
                ),
            ),
          ),
        );
      }),
      !status.changes.length &&
        !error &&
        React.createElement(
          "p",
          { style: { fontSize: 12, color: "var(--fg-muted)" } },
          tr("No disk changes"),
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
          subscribe: (listener:()=>void) => {listeners.add(listener);return ()=>{listeners.delete(listener);};},
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
      command("git.push", "Push", () => request("push").then(refresh));
      command("git.fetch", "Fetch", () => request("fetch").then(refresh));
      command("git.stage", "Stage File", () => {
        const path = o.workbench.activePath();
        if (path) return stage(path);
      });
      command("git.stageAll", "Stage All Changes", async () => {
        await refresh();
        for (const change of [...status.changes].filter(unstaged))
          await stage(change.path);
      });
      command("git.unstage", "Unstage File", () => {
        const path = o.workbench.activePath();
        if (path) return request("unstage", { path }).then(refresh);
      });
      command("git.unstageAll", "Unstage All Changes", async () => {
        await refresh();
        for (const change of status.changes.filter(staged))
          await request("unstage", { path: change.path });
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
        ctx.subscribe(o.runtime.subscribe("operation.recovered", operation => {
          if (!operation.method?.startsWith("git.")) return;
          if (operation.status === "completed") { o.workbench.notify(`${operation.method}: operation completed after reconnect`); void refresh().catch(()=>{}); }
          else if (["failed","interrupted","unknown"].includes(operation.status)) o.workbench.notify(operation.error?.message??`${operation.method}: ${operation.status}; inspect repository state before retrying`,"warning");
        }));
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
      schedule();
      ctx.subscribe(() => {
        disposed = true;
        clearTimeout(timer);
        clearTimeout(refreshTimer);
        fetchController?.abort();
        cloneController?.abort();
        listeners.clear();
      });
    },
  };
}
