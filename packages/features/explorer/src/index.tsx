import { translate as tr } from "@oxbit/ui";
import { Outline } from "./outline.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { FileBadge, FolderIcon, FolderArrow, Icon, IconButton } from "@oxbit/ui";
import type { WorkbenchController } from "@oxbit/workbench";
import type { Extension, FileEntry, FileSystem, Kernel } from "@oxbit/sdk";
import type { DocumentService } from "@oxbit/documents";
export function Explorer({
  workbench,
  documents,
}: {
  workbench: WorkbenchController;
  documents: DocumentService;
}) {
  const s = useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const [, refreshBadges] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(false);
  useEffect(() => {
    const diagnostics = workbench.kernel.events.on("diagnostics.change", () =>
      refreshBadges((value) => value + 1),
    );
    const git = workbench.kernel.services.optional<{
      subscribe?(fn: () => void): () => void;
    }>("git");
    const stop = git?.subscribe?.(() => refreshBadges((value) => value + 1));
    return () => {
      diagnostics.dispose();
      stop?.();
    };
  }, [workbench]);
  const gitChanges =
    workbench.kernel.services
      .optional<{
        status?: () => {
          changes: { path: string; index: string; working: string }[];
        };
      }>("git")
      ?.status?.().changes || [];
  const diagnostics = workbench.kernel.services.optional<{
    diagnostics?: Map<string, unknown[]>;
  }>("language")?.diagnostics;
  const [openEditors, setOpenEditors] = useState(true),
    [tree, setTree] = useState(true);
  const visible = s.files
    .filter((file) =>
      file.path
        .split("/")
        .slice(0, -1)
        .every((_, i, parts) =>
          s.expanded.includes(parts.slice(0, i + 1).join("/")),
        ),
    )
    .sort((a, b) => {
      const ap = a.path.split("/"),
        bp = b.path.split("/");
      for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
        if (ap[i] === bp[i]) continue;
        const ad = i < ap.length - 1 || a.kind === "directory",
          bd = i < bp.length - 1 || b.kind === "directory";
        return ad !== bd
          ? ad
            ? -1
            : 1
          : (ap[i] || "").localeCompare(bp[i] || "");
      }
      return 0;
    });
  const toggle = (path: string) =>
    workbench.set({
      expanded: s.expanded.includes(path)
        ? s.expanded.filter((p) => p !== path)
        : [...s.expanded, path],
    });
  const open = (e: FileEntry, preview = true) => {
    workbench.set({ selectedPath: e.path });
    if (e.kind === "directory") toggle(e.path);
    else
      void workbench
        .openFile(e.path, { preview })
        .catch((error) => workbench.notify(String(error), "error"));
  };
  const menu = (e: React.MouseEvent, path?: string) => {
    e.preventDefault();
    workbench.set({
      selectedPath: path,
      menu: {
        name: "context",
        location: "explorer",
        x: e.clientX,
        y: e.clientY,
        ids: [
          "file.new",
          "file.newFolder",
          "-",
          "file.rename",
          "file.delete",
          "-",
          "file.copyPath",
          "file.reveal",
        ],
      },
    });
  };
  // Touch devices reorder and move files through long-press menus; HTML5 drag stays for mice.
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const t =
    workbench.kernel.configuration.get("workbench.locale") === "de"
      ? { open: "Geöffnete Editoren", outline: "Gliederung" }
      : { open: "Open Editors", outline: "Outline" };
  return (
    <div className="explorer-content" onContextMenu={(e) => menu(e)}>
      <button
        className="section-label"
        onClick={() => setOpenEditors(!openEditors)}
        aria-expanded={openEditors}
      >
        <Icon name={openEditors ? "chevD" : "chevR"} size={12} />
        {t.open}
        <span className="push muted">
          {[...documents.documents.values()].filter((d) => d.dirty).length ||
            ""}
        </span>
      </button>
      {openEditors && (
        <div role="list">
          {s.groups.flatMap((g) =>
            g.tabs
              .filter((t) => t.path)
              .map((tab) => (
                <div
                  key={g.id + tab.id}
                  className={`open-editor tree-row ${g.active === tab.id && s.activeGroup === g.id ? "selected" : ""}`}
                  role="listitem"
                >
                  <IconButton
                    icon="x"
                    label={tr("Close {0}", { "0": tab.title })}
                    onClick={() =>
                      void workbench.run("editor.closeTab", {
                        groupId: g.id,
                        tabId: tab.id,
                      })
                    }
                  />
                  <button
                    className="file-row-button"
                    onClick={() =>
                      tab.component
                        ? workbench.activateTab(g.id, tab.id)
                        : void workbench.openFile(tab.path!, { groupId: g.id })
                    }
                  >
                    <FileBadge kernel={workbench.kernel} path={tab.path!} />
                    <span className={tab.preview ? "preview" : ""}>
                      {tab.title}
                    </span>
                    {documents.get(tab.path!)?.dirty && (
                      <span className="dirty-dot" />
                    )}
                    <span className="push muted">
                      {s.groups.length > 1
                        ? tr("G{0}", { "0": s.groups.indexOf(g) + 1 })
                        : tab.path!.split("/").slice(0, -1).join("/")}
                    </span>
                  </button>
                </div>
              )),
          )}
        </div>
      )}
      <button
        className="section-label border-top"
        onClick={() => setTree(!tree)}
        aria-expanded={tree}
      >
        <FolderArrow path={s.projectName} root expanded={tree} />
        <FolderIcon path={s.projectName} root expanded={tree} />
        {s.projectName}
      </button>
      {tree && (
        <div
          role="tree"
          aria-label={tr("Files")}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            if (e.target !== e.currentTarget) return;
            const from = e.dataTransfer.getData("oxbit/file");
            if (from)
              void workbench.run("file.move", {
                from,
                to: from.split("/").pop(),
              });
          }}
        >
          {visible.map((entry, index) => {
            const doc = documents.get(entry.path),
              expanded = s.expanded.includes(entry.path),
              selected = s.selectedPath === entry.path;
            const change = gitChanges.find(
              (change) => change.path === entry.path,
            );
            const badge = change
              ? [change.index, change.working].includes("U")
                ? "C"
                : change.working === "?"
                  ? "U"
                  : change.working.trim() || change.index.trim()
              : undefined;
            const hasDiagnostics = [...(diagnostics?.entries() || [])].some(
              ([path, items]) =>
                items.length &&
                (path === entry.path || path.endsWith("/" + entry.path)),
            );
            return (
              <div
                key={entry.path}
                role="treeitem"
                aria-level={entry.path.split("/").length}
                aria-expanded={
                  entry.kind === "directory" ? expanded : undefined
                }
                aria-selected={selected}
                tabIndex={selected || (!s.selectedPath && index === 0) ? 0 : -1}
                draggable={!touch}
                className={`tree-row ${selected ? "selected" : ""} ${doc?.state === "missing" ? "missing" : ""} ${doc?.state === "conflict" ? "external-change" : ""}`}
                style={{ paddingLeft: entry.path.split("/").length * 12 + 4 }}
                title={entry.path}
                onFocus={() => {
                  if (!selected) workbench.set({ selectedPath: entry.path });
                }}
                onClick={() => open(entry)}
                onDoubleClick={() =>
                  entry.kind === "file" &&
                  void workbench.openFile(entry.path, { preview: false })
                }
                onContextMenu={(e) => {
                  e.stopPropagation();
                  menu(e, entry.path);
                }}
                onDragStart={(e) =>
                  e.dataTransfer.setData("oxbit/file", entry.path)
                }
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const from = e.dataTransfer.getData("oxbit/file");
                  const dir =
                    entry.kind === "directory"
                      ? entry.path
                      : entry.path.split("/").slice(0, -1).join("/");
                  if (from)
                    void workbench.run("file.move", {
                      from,
                      to: (dir ? dir + "/" : "") + from.split("/").pop(),
                    });
                }}
                onKeyDown={(e) => {
                  if (["ArrowUp", "ArrowDown"].includes(e.key)) {
                    e.preventDefault();
                    const next =
                      visible[index + (e.key === "ArrowDown" ? 1 : -1)];
                    if (next) {
                      workbench.set({ selectedPath: next.path });
                      (
                        e.currentTarget.parentElement?.children[
                          index + (e.key === "ArrowDown" ? 1 : -1)
                        ] as HTMLElement
                      )?.focus();
                    }
                  } else if (
                    e.key === "ArrowRight" &&
                    entry.kind === "directory" &&
                    !expanded
                  )
                    toggle(entry.path);
                  else if (
                    e.key === "ArrowLeft" &&
                    entry.kind === "directory" &&
                    expanded
                  )
                    toggle(entry.path);
                  else if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    workbench.set({ selectedPath: entry.path });
                    if (e.key === "Enter" && entry.kind === "file")
                      void workbench.run("file.rename");
                    else open(entry, true);
                  } else if (e.key === "F2") {
                    e.preventDefault();
                    void workbench.run("file.rename");
                  } else if (e.key === "Delete") {
                    e.preventDefault();
                    void workbench.run("file.delete");
                  }
                }}
              >
                <span className="tree-chevron">
                  {entry.kind === "directory" && (
                    <FolderArrow path={entry.path} expanded={expanded} />
                  )}
                </span>
                {entry.kind === "directory" ? (
                  <FolderIcon path={entry.path} expanded={expanded} />
                ) : (
                  <FileBadge kernel={workbench.kernel} path={entry.path} />
                )}
                <span className="truncate">{entry.name}</span>
                <span className="push" />
                {doc?.dirty && <span className="dirty-dot" />}
                {hasDiagnostics && (
                  <span
                    className="diagnostic-dot"
                    title={tr("File has diagnostics")}
                    aria-label={tr("File has diagnostics")}
                  />
                )}
                {badge && (
                  <span
                    className="git-badge"
                    aria-label={tr("Git status: {0}", { 0: badge })}
                  >
                    {badge}
                  </span>
                )}
                {(entry.readonly || doc?.readonly) && (
                  <Icon name="lock" size={12} />
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="explorer-spacer" />
      <details className="outline" onToggle={event => setOutlineOpen(event.currentTarget.open)}>
        <summary className="section-label border-top">{t.outline}</summary>
        {outlineOpen && <Outline workbench={workbench} />}
      </details>
    </div>
  );
}
export function createFeature({
  kernel,
  workbench,
  filesystem,
  documents,
}: {
  kernel: Kernel;
  workbench: WorkbenchController;
  filesystem: FileSystem;
  documents: DocumentService;
}): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.explorer",
      name: "File Explorer",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["filesystem.read", "filesystem.write"],
    },
    activate(ctx) {
      ctx.own(
        ctx.contributions.register({
          id: "explorer",
          kind: "activityView",
          title: "Explorer",
          order: 0,
          component: () => (
            <Explorer workbench={workbench} documents={documents} />
          ),
          data: { icon: "files" },
        }),
      );
      const cmd = (
        id: string,
        title: string,
        run: (args?: any) => unknown,
        shortcut?: string,
      ) =>
        ctx.own(
          ctx.commands.register({ id, title, category: "File", shortcut, run }),
        );
      const parent = () => {
        const p = workbench.state.selectedPath;
        return p
          ? workbench.state.files.find((f) => f.path === p)?.kind ===
            "directory"
            ? p
            : p.split("/").slice(0, -1).join("/")
          : "";
      };
      for (const folder of [false, true])
        cmd(
          folder ? "file.newFolder" : "file.new",
          folder ? "New Folder" : "New File",
          async () => {
            const dir = parent();
            const name = await workbench.prompt(
              folder ? tr("New Folder") : tr("New File"),
            );
            if (!name) return;
            if (
              name.startsWith("/") ||
              name.split("/").some((p) => p === ".." || !p)
            )
              throw new Error(
                "Enter a relative path without empty or parent segments.",
              );
            const path = (dir ? dir + "/" : "") + name;
            if (folder) await filesystem.mkdir(path);
            else await filesystem.write(path, "", { expectedRevision: null });
            workbench.revealFile(path);
            await workbench.refreshFiles();
            if (!folder) await workbench.openFile(path);
          },
          folder ? undefined : "Ctrl+N",
        );
      cmd(
        "view.explorer",
        "Show Explorer",
        () => workbench.openSidebar("explorer"),
        "Ctrl+Shift+E",
      );
      cmd(
        "file.save",
        "Save",
        () => {
          const path = workbench.activePath();
          if (path) return documents.save(path);
        },
        "Ctrl+S",
      );
      cmd(
        "file.saveAll",
        "Save All",
        async () => {
          for (const doc of documents.documents.values())
            if (doc.dirty) await documents.save(doc.path);
        },
        "Ctrl+K S",
      );
      cmd("file.revert", "Revert File", async () => {
        const path = workbench.activePath();
        if (!path) return;
        if (
          (await workbench.ask(
            tr("Revert file?"),
            tr("Discard unsaved changes and reload the current file?"),
            ["Revert", "Cancel"],
            true,
          )) !== "Revert"
        )
          return;
        await documents.reload(path);
      });
      cmd("file.rename", "Rename…", async () => {
        const from = workbench.state.selectedPath || workbench.activePath();
        if (!from) return;
        const value = await workbench.prompt(
          tr("Rename"),
          from.split("/").pop(),
        );
        if (!value || value === from.split("/").pop()) return;
        await kernel.commands.execute("file.move", {
          from,
          to: [...from.split("/").slice(0, -1), value].join("/"),
          confirmed: true,
        });
      });
      cmd(
        "file.move",
        "Move File",
        async (args: { from: string; to: string; confirmed?: boolean }) => {
          if (!args?.from || !args.to || args.from === args.to) return;
          if (
            !args.confirmed &&
            (await workbench.ask(
              tr("Move file?"),
              `${args.from} → ${args.to}`,
              ["Move", "Cancel"],
            )) !== "Move"
          )
            return;
          await documents.applyEdits(
            [],
            [{ kind: "rename", path: args.from, to: args.to }],
          );
          workbench.set({
            groups: workbench.state.groups.map((g) => ({
              ...g,
              tabs: g.tabs.map((t) =>
                t.path === args.from || t.path?.startsWith(args.from + "/")
                  ? {
                      ...t,
                      id: args.to + t.path!.slice(args.from.length),
                      path: args.to + t.path!.slice(args.from.length),
                      title: (args.to + t.path!.slice(args.from.length))
                        .split("/")
                        .pop()!,
                    }
                  : t,
              ),
              active:
                g.active === args.from || g.active?.startsWith(args.from + "/")
                  ? args.to + g.active.slice(args.from.length)
                  : g.active,
            })),
            selectedPath: args.to,
            expanded: workbench.state.expanded.map((path) =>
              path === args.from || path.startsWith(args.from + "/")
                ? args.to + path.slice(args.from.length)
                : path,
            ),
          });
          workbench.revealFile(args.to);
          await workbench.refreshFiles();
        },
      );
      cmd("file.delete", "Delete", async () => {
        const path = workbench.state.selectedPath;
        if (!path) return;
        if (
          (await workbench.ask(
            tr("Delete file?"),
            tr("Delete {0} and its contents?", { "0": path }),
            ["Delete", "Cancel"],
            true,
          )) !== "Delete"
        )
          return;
        await documents.applyEdits([], [{ kind: "delete", path }]);
        workbench.set({
          expanded: workbench.state.expanded.filter(
            (directory) => directory !== path && !directory.startsWith(path + "/"),
          ),
          groups: workbench.state.groups.map((g) => {
            const tabs = g.tabs.filter(
              (t) => t.path !== path && !t.path?.startsWith(path + "/"),
            );
            return {
              ...g,
              tabs,
              active: tabs.some((t) => t.id === g.active)
                ? g.active
                : tabs[0]?.id,
            };
          }),
        });
        await workbench.refreshFiles();
      });
      cmd(
        "file.copyPath",
        "Copy Path",
        () =>
          navigator.clipboard.writeText(
            workbench.state.selectedPath || workbench.activePath() || "",
          ),
        "Ctrl+Alt+C",
      );
      cmd("file.reveal", "Reveal Active File in Explorer", () => {
        const path = workbench.activePath();
        if (path) {
          workbench.revealFile(path);
          workbench.set({
            sidebar: true,
            sidebarId: "explorer",
          });
        }
      });
      ctx.own(filesystem.watch(workbench.scheduleRefreshFiles));
    },
  };
}
