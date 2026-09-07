import { translate as tr, setLocale } from "@zapp/ui";
import { findWorkspaceFiles } from "./files.js";
import {
  Component,
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  languageIdForPath,
  type Extension,
  type Kernel,
  type Contribution,
  type RpcClient,
} from "@zapp/sdk";
import {
  Icon,
  IconButton,
  FileBadge,
  EmptyState,
  Dialog,
  IconProvider,
} from "@zapp/ui";
import {
  WorkbenchController,
  type Group,
  type Tab,
  type Notification,
} from "./controller.js";
import catalog from "./catalog.json";
import { menuContributions, themeVariables } from "./contributions.js";
import {
  normalizeShortcut,
  keyboardShortcut,
  shortcutCandidates,
  resolveWorkbenchShortcut,
  displayShortcut,
} from "./shortcuts.js";
export * from "./controller.js";
export { workspaceEntries } from "./files.js";
export { normalizeShortcut, displayShortcut } from "./shortcuts.js";
export function useWorkbench(workbench: WorkbenchController) {
  return useSyncExternalStore(workbench.subscribe, workbench.snapshot);
}
export function createWorkbenchFeature(
  workbench: WorkbenchController,
): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "zapp.workbench",
      name: "Workbench",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
    },
    activate(ctx) {
      const add = (
        id: string,
        title: string,
        run: () => unknown,
        shortcut?: string,
        when?: string,
      ) => ctx.own(ctx.commands.register({ id, title, run, shortcut, when }));
      for (const [id, mode] of [
        ["workbench.showCommands", "commands"],
        ["workbench.quickOpen", "files"],
        ["workbench.gotoSymbol", "symbols"],
        ["workbench.gotoLine", "line"],
        ["workbench.recent", "recent"],
      ]) {
        const info = catalog.commands.find((c) => c.id === id);
        add(
          id,
          info?.title || id,
          () => workbench.openPalette(mode),
          info?.win,
        );
      }
      add(
        "view.toggleSidebar",
        "Toggle Sidebar",
        () => workbench.set({ sidebar: !workbench.state.sidebar }),
        "Ctrl+B",
      );
      add(
        "view.togglePanel",
        "Toggle Panel",
        () => workbench.set({ panel: !workbench.state.panel }),
        "Ctrl+J",
      );
      add(
        "view.focusMode",
        "Toggle Focus Mode",
        () => workbench.set({ focus: !workbench.state.focus }),
        "Ctrl+K Z",
      );
      add("view.resetLayout", "Reset Workspace Layout", () =>
        workbench.resetLayout(),
      );
      add("notifications.clear", "Clear All Notifications", () =>
        workbench.set({ notifications: [] }),
      );
      add("help.about", "About Zapp", () =>
        workbench.ask(
          tr("Zapp"),
          tr("React 19 · CodeMirror 6 · Yjs · Public extension SDK 1.0.0") +
            "\nMIT · Ryan Yannelli <ryanyannelli@gmail.com> · https://github.com/yannelli · /LICENSE.txt",
          ["OK"],
        ),
      );
      for (const [id, panel] of [
        ["view.search", "search"],
        ["view.scm", "scm"],
        ["view.problems", "problems"],
        ["view.output", "output"],
      ])
        add(
          id,
          catalog.commands.find((c) => c.id === id)?.title || id,
          () => workbench.openPanel(panel),
          catalog.commands.find((c) => c.id === id)?.win,
          "surface:" + panel,
        );
      const surfaceCommands = new Map<string, { dispose(): void }>();
      const refreshSurfaces = () => {
        const surfaces = ctx.contributions
          .list()
          .filter(
            (item) =>
              ["tab", "activityView", "panel"].includes(item.kind) &&
              item.component,
          );
        const ids = new Set(surfaces.map((item) => item.id));
        for (const id of ["search", "scm", "problems", "output"])
          ctx.context.set("surface:" + id, ids.has(id));
        for (const [id, registration] of surfaceCommands)
          if (!ids.has(id)) {
            registration.dispose();
            surfaceCommands.delete(id);
          }
        for (const surface of surfaces)
          if (!surfaceCommands.has(surface.id))
            surfaceCommands.set(
              surface.id,
              ctx.commands.register({
                id: "workbench.surface." + surface.id,
                title: tr("Open {0}", { 0: tr(surface.title) }),
                category: "View",
                run: () => {
                  if (surface.kind === "tab")
                    workbench.openView(
                      surface.id,
                      surface.title,
                      surface.component!,
                      {},
                      { contributionId: surface.id },
                    );
                  else workbench.openPanel(surface.id);
                },
              }),
            );
        workbench.synchronizeContributions();
      };
      ctx.subscribe(ctx.contributions.subscribe(refreshSurfaces));
      ctx.subscribe(() => {
        for (const registration of surfaceCommands.values())
          registration.dispose();
        surfaceCommands.clear();
      });
      refreshSurfaces();
      ctx.subscribe(ctx.configuration.subscribe(workbench.touch));
    },
  };
}
function useKeyboard(workbench: WorkbenchController) {
  const chord = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const escapeTime = useRef(0);
  useEffect(() => {
    const clearChord = () => {
      chord.current = "";
      if (workbench.state.chord) workbench.set({ chord: undefined });
    };
    const commands = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        ["Meta", "Control", "Shift", "Alt"].includes(event.key)
      )
        return;
      const target = event.target as HTMLElement;
      const state = workbench.state;
      if (
        state.dialog ||
        target.closest('[role="dialog"],[role="alertdialog"]')
      )
        return;
      const focus = target.closest(".xterm")
        ? "terminal"
        : target.closest(".cm-editor")
          ? "editor"
          : target.closest('[role="tree"]')
            ? "explorer"
            : "other";
      workbench.kernel.context.set("editorFocus", focus === "editor");
      workbench.kernel.context.set("terminalFocus", focus === "terminal");
      const combination =
        (chord.current ? chord.current + " " : "") + keyboardShortcut(event);
      const key = normalizeShortcut(combination);
      const candidates = shortcutCandidates(
        workbench.kernel,
        state.keybindings,
        focus,
      );
      const selected = resolveWorkbenchShortcut(
        workbench.kernel,
        state.keybindings,
        combination,
        focus,
      );
      const prefix = candidates.some((item) =>
        normalizeShortcut(item.key).startsWith(key + " "),
      );
      if (prefix && !(focus === "terminal" && selected)) {
        event.preventDefault();
        event.stopPropagation();
        chord.current = combination;
        workbench.set({ chord: combination });
        clearTimeout(timer.current);
        timer.current = setTimeout(clearChord, 3000);
        return;
      }
      clearChord();
      if (!selected) return;
      if (
        focus === "other" &&
        target.closest('input,textarea,[contenteditable="true"]') &&
        selected.id.startsWith("editor.")
      )
        return;
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !/^F\d/.test(event.key) &&
        !combination.includes(" ")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void workbench.run(selected.id);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const state = workbench.state;
      if (state.dialog) return;
      if (state.menu) {
        workbench.set({ menu: undefined });
        event.preventDefault();
        return;
      }
      if (state.palette) {
        workbench.set({ palette: undefined });
        event.preventDefault();
        return;
      }
      if (state.notificationCenter) {
        workbench.set({ notificationCenter: false });
        return;
      }
      if ((globalThis.innerWidth || 1440) < 1100 && state.sidebar) {
        workbench.set({ sidebar: false });
        return;
      }
      if ((globalThis.innerWidth || 1440) < 1100 && state.panel) {
        workbench.set({ panel: false });
        return;
      }
      if (state.focus && performance.now() - escapeTime.current < 600)
        workbench.set({ focus: false });
      escapeTime.current = performance.now();
      clearChord();
    };
    window.addEventListener("keydown", commands, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", commands, true);
      window.removeEventListener("keydown", escape);
      clearTimeout(timer.current);
    };
  }, [workbench]);
}
class Boundary extends Component<
  { children: ReactNode; name: string },
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <EmptyState title={tr("{0} failed", { "0": this.props.name })}>
        <p role="alert">{this.state.error}</p>
        <button
          className="button"
          onClick={() => this.setState({ error: undefined })}
        >
          {tr("Retry")}
        </button>
      </EmptyState>
    ) : (
      this.props.children
    );
  }
}
export function Workbench({
  workbench,
  runtime,
  onConnect,
  onOpenWorkspace,
}: {
  workbench: WorkbenchController;
  runtime?: RpcClient;
  onConnect?: () => void;
  onOpenWorkspace?: () => void;
}) {
  const s = useWorkbench(workbench),
    kernel = workbench.kernel;
  useKeyboard(workbench);
  const [width, setWidth] = useState(innerWidth);
  const [conn, setConn] = useState(
    runtime?.connected ? "Connected" : "Browser workspace",
  );
  useEffect(() => {
    const resize = () => setWidth(innerWidth);
    window.addEventListener("resize", resize);
    const off = runtime?.subscribe("connection.change", (e) => {
      setConn(e.state === "connected" ? "Connected" : e.state);
      workbench.touch();
    });
    return () => {
      window.removeEventListener("resize", resize);
      off?.();
    };
  }, [runtime, workbench]);
  const mode = width < 600 ? "phone" : width < 1100 ? "tablet" : "desktop";
  const chosenTheme = kernel.contributions
    .list("theme")
    .find(
      (item) => item.title === kernel.configuration.get("workbench.colorTheme"),
    );
  const theme =
    (chosenTheme?.data as { mode?: string })?.mode === "light"
      ? "light"
      : "dark";
  const locale =
    kernel.configuration.get("workbench.locale") === "de" ? "long" : "en";
  const t = catalog.strings[locale];
  setLocale(locale);
  const views = kernel.contributions.list("activityView");
  const panels = kernel.contributions.list("panel");
  const sidebar = views.find((v) => v.id === s.sidebarId);

  const dirty = [...workbench.documents.documents.values()].filter(
    (d) => d.dirty,
  ).length;
  const conf =
    kernel.configuration.get<string>("workbench.sidebarLocation") === "right";
  const status = kernel.contributions.list("statusItem");
  const command = (id: string) => () => void workbench.run(id);
  const label = (view: Contribution) =>
    (t as Record<string, string>)[view.id] || tr(view.title);
  const icon = (view: Contribution) =>
    (view.data as any)?.icon ||
    (
      {
        explorer: "files",
        search: "search",
        scm: "git",
        extensions: "ext",
      } as Record<string, string>
    )[view.id] ||
    "package";
  const startResize = (
    event: React.PointerEvent,
    kind: "sidebar" | "panel",
  ) => {
    event.preventDefault();
    const start = kind === "sidebar" ? event.clientX : event.clientY;
    const initial = kind === "sidebar" ? s.sidebarWidth : s.panelHeight;
    const move = (e: PointerEvent) => {
      if (kind === "sidebar")
        workbench.set({
          sidebarWidth: Math.max(
            180,
            Math.min(520, initial + (e.clientX - start) * (conf ? -1 : 1)),
          ),
        });
      else
        workbench.set({
          panelHeight: Math.max(
            100,
            Math.min(600, initial + start - e.clientY),
          ),
          maxPanel: false,
        });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };
  return (
    <IconProvider
      values={Object.fromEntries(
        kernel.contributions
          .list("icon")
          .map((item) => [
            item.id,
            (item.data as { path?: string })?.path || "",
          ]),
      )}
    >
      <div
        style={themeVariables(kernel)}
        className={`workbench ${s.focus ? "focus-mode" : ""} ${conf ? "sidebar-right" : ""}`}
        data-screen-label="Workbench"
        data-theme={theme}
        data-density={
          kernel.configuration.get("workbench.density") || "compact"
        }
        data-mode={mode}
        data-rm={
          kernel.configuration.get("workbench.reducedMotion") ? "1" : "0"
        }
        onClick={() => s.menu && workbench.set({ menu: undefined })}
      >
        {!s.focus && (
          <header
            className="titlebar"
            role="menubar"
            aria-label={tr("Application menu")}
          >
            <div className="brand">Z</div>
            {mode === "desktop" &&
              Object.keys(catalog.menus).map((name) => (
                <div className="menu-parent" key={name}>
                  <button
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={s.menu?.name === name}
                    className={s.menu?.name === name ? "selected" : ""}
                    onClick={(e) => {
                      e.stopPropagation();
                      workbench.set({
                        menu: s.menu?.name === name ? undefined : { name },
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" || event.key === "Enter") {
                        event.preventDefault();
                        workbench.set({ menu: { name } });
                      }
                      if (
                        event.key === "ArrowRight" ||
                        event.key === "ArrowLeft"
                      ) {
                        event.preventDefault();
                        const menus = Array.from(
                          event.currentTarget
                            .closest("header")!
                            .querySelectorAll<HTMLButtonElement>(
                              ".menu-parent>button",
                            ),
                        );
                        menus[
                          (menus.indexOf(event.currentTarget) +
                            (event.key === "ArrowRight"
                              ? 1
                              : menus.length - 1)) %
                            menus.length
                        ]?.focus();
                      }
                    }}
                    onMouseEnter={() =>
                      s.menu &&
                      s.menu.name !== "context" &&
                      workbench.set({ menu: { name } })
                    }
                  >
                    {tr(name)}
                  </button>
                  {s.menu?.name === name && (
                    <CommandMenu
                      workbench={workbench}
                      ids={(catalog.menus as Record<string, string[]>)[name]!}
                      location={name}
                    />
                  )}
                </div>
              ))}
            <button className="workspace-title" onClick={onOpenWorkspace}>
              {s.projectName}
              <Icon name="chevD" size={12} />
            </button>
            <button
              className="title-search"
              onClick={command("workbench.quickOpen")}
              aria-label={tr("Search files and commands")}
            >
              <Icon name="search" size={14} />
              <span>
                {s.projectName} {tr("— search files, type › for commands")}
              </span>
              <kbd>Ctrl P</kbd>
            </button>
            <div className="title-actions">
              <button
                className={`connection-button ${runtime?.connected ? "connected" : ""}`}
                onClick={onConnect}
                aria-label={tr("Runtime connection")}
              >
                <Icon
                  name={runtime?.connected ? "cloudCheck" : "cloud"}
                  size={14}
                />
                <span>{tr(conn)}</span>
              </button>
              <ToolbarContributions workbench={workbench} location="titlebar" />
              <IconButton
                icon="bell"
                label={tr("Notifications ({0})", {
                  "0": s.notifications.length,
                })}
                onClick={() =>
                  workbench.set({ notificationCenter: !s.notificationCenter })
                }
              />
              <span className="title-divider" />
              <IconButton
                icon="layoutSide"
                label={tr("Toggle sidebar")}
                aria-pressed={s.sidebar}
                onClick={command("view.toggleSidebar")}
              />
              <IconButton
                icon="layoutPanel"
                label={tr("Toggle panel")}
                aria-pressed={s.panel}
                onClick={command("view.togglePanel")}
              />
              <IconButton
                icon="focus"
                label={tr("Focus mode")}
                onClick={command("view.focusMode")}
              />
              <IconButton
                icon={theme === "dark" ? "sun" : "moon"}
                label={tr("Toggle theme")}
                onClick={command("theme.toggle")}
              />
            </div>
          </header>
        )}
        {s.workspaceOpen ? (
          <div className="workspace-body">
            {!s.focus && (
              <nav className="activity-bar" aria-label={tr("Primary views")}>
                {views
                  .filter((view) =>
                    ["explorer", "search", "scm", "extensions"].includes(
                      view.id,
                    ),
                  )
                  .concat(
                    views
                      .filter(
                        (view) =>
                          !["explorer", "search", "scm", "extensions"].includes(
                            view.id,
                          ),
                      )
                      .slice(0, 3),
                  )
                  .map((view) => (
                    <button
                      key={view.id}
                      title={label(view)}
                      aria-label={label(view)}
                      aria-pressed={s.sidebarId === view.id && s.sidebar}
                      className={
                        s.sidebarId === view.id && s.sidebar ? "active" : ""
                      }
                      onClick={() =>
                        workbench.set({
                          sidebar: s.sidebarId === view.id ? !s.sidebar : true,
                          sidebarId: view.id,
                        })
                      }
                    >
                      <Icon name={icon(view)} size={18} />
                      {view.id === "explorer" && dirty > 0 && (
                        <span className="badge">{dirty}</span>
                      )}
                      <span className="phone-label">{label(view)}</span>
                    </button>
                  ))}
                {views.filter(
                  (view) =>
                    !["explorer", "search", "scm", "extensions"].includes(
                      view.id,
                    ),
                ).length > 3 && (
                  <button
                    aria-label={tr("More views")}
                    onClick={(event) => {
                      event.stopPropagation();
                      workbench.set({
                        menu: {
                          name: "context",
                          location: "activity",
                          x: event.clientX,
                          y: event.clientY,
                          ids: views
                            .filter(
                              (view) =>
                                ![
                                  "explorer",
                                  "search",
                                  "scm",
                                  "extensions",
                                ].includes(view.id),
                            )
                            .slice(3)
                            .map((view) => "workbench.surface." + view.id),
                        },
                      });
                    }}
                  >
                    <Icon name="more" />
                  </button>
                )}
                <span className="activity-spacer" />
                <button
                  title={t.settings}
                  aria-label={t.settings}
                  onClick={command("settings.open")}
                >
                  <Icon name="gear" size={18} />
                  <span className="phone-label">{t.settings}</span>
                </button>
                {mode === "phone" && (
                  <button
                    aria-label={tr("More")}
                    onClick={() => workbench.openPalette()}
                  >
                    <Icon name="more" />
                    <span className="phone-label">{tr("More")}</span>
                  </button>
                )}
              </nav>
            )}
            {s.sidebar && !s.focus && (
              <>
                {mode !== "desktop" && (
                  <button
                    className="sidebar-scrim"
                    aria-label={tr("Close sidebar")}
                    onClick={() => workbench.set({ sidebar: false })}
                  />
                )}
                <aside
                  className="sidebar"
                  aria-label={sidebar?.title || s.sidebarId}
                  style={{
                    width:
                      mode === "phone"
                        ? "100%"
                        : mode === "tablet"
                          ? 320
                          : s.sidebarWidth,
                  }}
                >
                  <div className="sidebar-heading">
                    <span>{sidebar ? label(sidebar) : s.sidebarId}</span>
                    <ToolbarContributions
                      workbench={workbench}
                      location={"sidebar:" + s.sidebarId}
                    />
                    <span className="push" />
                    {s.sidebarId === "explorer" && (
                      <>
                        <IconButton
                          icon="newFile"
                          label={tr("New File")}
                          onClick={command("file.new")}
                        />
                        <IconButton
                          icon="newFolder"
                          label={tr("New Folder")}
                          onClick={command("file.newFolder")}
                        />
                        <IconButton
                          icon="collapse"
                          label={tr("Collapse folders")}
                          onClick={() => workbench.set({ expanded: [] })}
                        />
                      </>
                    )}
                    {mode !== "desktop" && (
                      <IconButton
                        icon="x"
                        label={tr("Close sidebar")}
                        onClick={() => workbench.set({ sidebar: false })}
                      />
                    )}
                  </div>
                  <div className="sidebar-content">
                    {sidebar?.component ? (
                      <Boundary name={sidebar.title}>
                        <sidebar.component
                          kernel={kernel}
                          workbench={workbench}
                          documents={workbench.documents}
                        />
                      </Boundary>
                    ) : (
                      <EmptyState title={tr("View unavailable")} />
                    )}
                  </div>
                  {mode === "desktop" && (
                    <div
                      className="sidebar-sash"
                      role="separator"
                      aria-label={tr("Resize sidebar")}
                      aria-orientation="vertical"
                      tabIndex={0}
                      onPointerDown={(e) => startResize(e, "sidebar")}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowLeft" || e.key === "ArrowRight")
                          workbench.set({
                            sidebarWidth: Math.max(
                              180,
                              Math.min(
                                520,
                                s.sidebarWidth +
                                  (e.key === "ArrowRight" ? 10 : -10),
                              ),
                            ),
                          });
                      }}
                    />
                  )}
                </aside>
              </>
            )}
            <main className="main-workbench">
              <div
                className="editor-groups"
                style={{
                  flexDirection: s.direction,
                  display: s.maxPanel && s.panel ? "none" : undefined,
                }}
              >
                {s.groups.map((group, i) => (
                  <Fragment key={group.id}>
                    {i > 0 && <GroupSash workbench={workbench} index={i} />}
                    <EditorGroup
                      group={group}
                      workbench={workbench}
                      first={i === 0}
                    />
                  </Fragment>
                ))}
              </div>
              {s.panel && !s.focus && (
                <>
                  {mode !== "desktop" && (
                    <button
                      className="panel-scrim"
                      aria-label={tr("Close panel")}
                      onClick={() => void workbench.run("view.togglePanel")}
                    />
                  )}
                  <section
                    className={`bottom-panel ${s.maxPanel ? "maximized" : ""}`}
                    aria-label={tr("Panel")}
                    style={{
                      height: s.maxPanel
                        ? "100%"
                        : mode === "desktop"
                          ? s.panelHeight
                          : mode === "tablet"
                            ? "45%"
                            : "50%",
                    }}
                  >
                    <div
                      className="panel-sash"
                      role="separator"
                      aria-label={tr("Resize panel")}
                      aria-orientation="horizontal"
                      tabIndex={0}
                      onPointerDown={(e) => startResize(e, "panel")}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowUp" || e.key === "ArrowDown")
                          workbench.set({
                            panelHeight: Math.max(
                              100,
                              Math.min(
                                600,
                                s.panelHeight +
                                  (e.key === "ArrowUp" ? 10 : -10),
                              ),
                            ),
                          });
                      }}
                    />
                    <div className="panel-header">
                      <div
                        className="panel-tabs"
                        role="tablist"
                        aria-label={tr("Panel views")}
                      >
                        {panels.map((p) => (
                          <button
                            key={p.id}
                            role="tab"
                            aria-selected={p.id === s.panelId}
                            className={p.id === s.panelId ? "selected" : ""}
                            onClick={() =>
                              void workbench.run("workbench.surface." + p.id)
                            }
                          >
                            {(t as Record<string, string>)[p.id] || tr(p.title)}
                          </button>
                        ))}
                      </div>
                      <div className="panel-actions">
                        <ToolbarContributions
                          workbench={workbench}
                          location={"panel:" + s.panelId}
                        />
                        {s.panelId === "terminal" && (
                          <>
                            <IconButton
                              icon="plus"
                              label={tr("New Terminal")}
                              onClick={command("terminal.new")}
                            />
                            <IconButton
                              icon="splitR"
                              label={tr("Split Terminal")}
                              onClick={command("terminal.split")}
                            />
                          </>
                        )}
                        <IconButton
                          icon={s.maxPanel ? "minimize" : "maximize"}
                          label={tr("Maximize panel")}
                          onClick={() =>
                            workbench.set({ maxPanel: !s.maxPanel })
                          }
                        />
                        <IconButton
                          icon="x"
                          label={tr("Close panel")}
                          onClick={() => workbench.set({ panel: false })}
                        />
                      </div>
                    </div>
                    <div className="panel-content">
                      {panels.map((p) => {
                        const C = p.component;
                        return (
                          C && (
                            <div
                              key={p.id}
                              className="panel-instance"
                              style={{
                                display: p.id === s.panelId ? "block" : "none",
                              }}
                            >
                              <Boundary name={p.title}>
                                <C kernel={kernel} workbench={workbench} />
                              </Boundary>
                            </div>
                          )
                        );
                      })}
                      {!panels.some((p) => p.id === s.panelId) && (
                        <EmptyState title={tr("Panel unavailable")}>
                          <button className="button" onClick={onConnect}>
                            {tr("Connect runtime")}
                          </button>
                        </EmptyState>
                      )}
                    </div>
                  </section>
                </>
              )}
            </main>
          </div>
        ) : (
          <div className="welcome">
            <div className="welcome-inner">
              <div className="welcome-logo">Z</div>
              <h1>Zapp</h1>
              <p className="muted">{t.noWorkspace}</p>
              <div className="welcome-columns">
                <div>
                  <h2>{tr("Start")}</h2>
                  <button className="button" onClick={onOpenWorkspace}>
                    <Icon name="folder" />
                    {t.openFolder}
                  </button>
                  <button className="button" onClick={command("git.clone")}>
                    <Icon name="git" />
                    {t.cloneRepo}
                  </button>
                </div>
                <div>
                  <h2>{t.recent}</h2>
                  <button
                    className="recent-item"
                    onClick={() => workbench.set({ workspaceOpen: true })}
                  >
                    <Icon name="folder" />
                    <span>
                      {s.projectName}
                      <small>{workbench.filesystem.id}</small>
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {!s.focus && (
          <footer className="statusbar">
            <button onClick={onConnect} title={tr("Runtime connection")}>
              <Icon
                name={runtime?.connected ? "cloudCheck" : "cloudOff"}
                size={13}
              />
              <span>{runtime?.connected ? tr("Connected") : tr("Local")}</span>
            </button>
            {runtime && <GitBranch workbench={workbench} />}
            <button
              onClick={command("view.problems")}
              title={tr("Show Problems")}
            >
              <Icon name="error" size={12} />
              <DiagnosticCount kernel={kernel} />
            </button>
            {s.chord && (
              <span role="status" className="chord-hint">
                {displayShortcut(s.chord)}…
              </span>
            )}
            <span className="muted">
              {dirty
                ? tr("{0} unsaved", { "0": dirty })
                : tr("All changes saved")}
            </span>
            {status
              .filter((c) => c.location !== "right")
              .map((c) => (
                <StatusContribution
                  key={c.id}
                  contribution={c}
                  workbench={workbench}
                />
              ))}
            <span className="push" />
            <EditorStatus workbench={workbench} />
            {status
              .filter((c) => c.location === "right")
              .map((c) => (
                <StatusContribution
                  key={c.id}
                  contribution={c}
                  workbench={workbench}
                />
              ))}
            <IconButton
              icon="bell"
              label={tr("Open notifications")}
              onClick={() =>
                workbench.set({ notificationCenter: !s.notificationCenter })
              }
            />
          </footer>
        )}
        {s.focus && (
          <button
            className="exit-focus button"
            onClick={() => workbench.set({ focus: false })}
          >
            {tr("Exit focus mode (Esc Esc)")}
          </button>
        )}
        {s.palette && <Palette workbench={workbench} />}{" "}
        {s.menu?.name === "context" && (
          <div
            className="context-menu"
            style={{
              left: Math.min(s.menu.x || 0, width - 285),
              top: Math.min(s.menu.y || 0, innerHeight - 350),
            }}
          >
            <CommandMenu
              workbench={workbench}
              ids={s.menu.ids || []}
              location={s.menu.location || "editor"}
            />
          </div>
        )}
        {s.dialog && <WorkbenchDialog workbench={workbench} />}
        <Notifications workbench={workbench} />
      </div>
    </IconProvider>
  );
}
function DiagnosticCount({ kernel }: { kernel: Kernel }) {
  const [, render] = useState(0);
  useEffect(() => {
    const d = kernel.events.on("diagnostics.change", () =>
      render((n) => n + 1),
    );
    return () => d.dispose();
  }, [kernel]);
  const language = kernel.services.optional<any>("language");
  const all: any[] = [...(language?.diagnostics?.values() || [])].flat();
  return (
    <span>
      {all.filter((d) => d.severity === 1).length}{" "}
      <span className="muted">
        △ {all.filter((d) => d.severity !== 1).length}
      </span>
    </span>
  );
}
function StatusContribution({
  contribution: c,
  workbench,
}: {
  contribution: Contribution;
  workbench: WorkbenchController;
}) {
  const C = c.component;
  return C ? (
    <Boundary name={c.title}>
      <C />
    </Boundary>
  ) : (
    <button
      title={c.title}
      onClick={() => c.command && void workbench.run(c.command)}
    >
      {tr(c.title)}
    </button>
  );
}
async function chooseEncoding(workbench: WorkbenchController) {
  const path = workbench.activePath();
  if (!path) return;
  const doc = workbench.documents.get(path);
  if (!doc) return;
  const choice = await workbench.ask(
    tr("Save with Encoding"),
    tr("Select the encoding for the next save."),
    ["utf-8", "utf-8-bom", "utf-16le", "latin1", "Cancel"],
  );
  if (choice && choice !== "Cancel") {
    doc.encoding = choice as typeof doc.encoding;
    workbench.touch();
  }
}
function EditorGroup({
  group,
  workbench,
  first,
}: {
  group: Group;
  workbench: WorkbenchController;
  first: boolean;
}) {
  const s = workbench.state;
  const current = group.tabs.find((t) => t.id === group.active);
  const [failed, setFailed] = useState<string>();
  const active = s.activeGroup === group.id;
  const tabs = [...group.tabs].sort(
    (a, b) => Number(!!b.pinned) - Number(!!a.pinned),
  );
  return (
    <section
      className={`editor-group ${active ? "active-group" : ""} ${first ? "first" : ""}`}
      aria-label={tr("Editor group {0}", { "0": s.groups.indexOf(group) + 1 })}
      style={{ flex: group.size || 1 }}
      onPointerDown={() => !active && workbench.set({ activeGroup: group.id })}
    >
      <div
        className="tabbar"
        role="tablist"
        aria-label={tr("Open editors")}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const data = e.dataTransfer.getData("zapp/tab");
          if (data) {
            const d = JSON.parse(data);
            workbench.moveTab(d.group, d.id, group.id);
          }
        }}
      >
        {tabs.map((tab) => {
          const doc = tab.path ? workbench.documents.get(tab.path) : undefined;
          return (
            <div
              className={`editor-tab ${tab.id === group.active ? "active" : ""} ${tab.preview ? "preview" : ""} ${tab.pinned ? "pinned" : ""} ${doc?.state === "missing" ? "missing" : ""}`}
              key={tab.id}
              draggable
              onDragStart={(e) =>
                e.dataTransfer.setData(
                  "zapp/tab",
                  JSON.stringify({ group: group.id, id: tab.id }),
                )
              }
              onContextMenu={(e) => {
                e.preventDefault();
                workbench.set({
                  activeGroup: group.id,
                  groups: s.groups.map((g) =>
                    g.id === group.id ? { ...g, active: tab.id } : g,
                  ),
                  menu: {
                    name: "context",
                    location: "tab",
                    x: e.clientX,
                    y: e.clientY,
                    ids: [
                      "editor.pin",
                      "editor.keepOpen",
                      "-",
                      "editor.splitRight",
                      "editor.splitDown",
                      "editor.moveToNextGroup",
                      "-",
                      "editor.closeTab",
                      "editor.closeOthers",
                    ],
                  },
                });
              }}
              onAuxClick={(e) => {
                if (e.button === 1)
                  void workbench.run("editor.closeTab", {
                    groupId: group.id,
                    tabId: tab.id,
                  });
              }}
            >
              <button
                role="tab"
                aria-selected={tab.id === group.active}
                tabIndex={tab.id === group.active ? 0 : -1}
                title={tab.path || tab.title}
                onClick={() => {
                  setFailed(undefined);
                  if (tab.path && !tab.component)
                    void workbench
                      .openFile(tab.path, { groupId: group.id })
                      .catch((e) => setFailed(String(e)));
                  else workbench.activateTab(group.id, tab.id);
                }}
                onDoubleClick={() => {
                  workbench.activateTab(group.id, tab.id);
                  void workbench.run("editor.keepOpen");
                }}
                onKeyDown={(e) => {
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                  ) {
                    e.preventDefault();
                    const index = tabs.findIndex((item) => item.id === tab.id);
                    const next =
                      e.key === "Home"
                        ? tabs[0]
                        : e.key === "End"
                          ? tabs.at(-1)
                          : tabs[
                              (index +
                                (e.key === "ArrowRight"
                                  ? 1
                                  : tabs.length - 1)) %
                                tabs.length
                            ];
                    if (next) {
                      workbench.activateTab(group.id, next.id);
                      const tabbar =
                        e.currentTarget.parentElement?.parentElement;
                      requestAnimationFrame(() =>
                        tabbar
                          ?.querySelector<HTMLElement>(
                            '[role="tab"][aria-selected="true"]',
                          )
                          ?.focus(),
                      );
                    }
                  }
                  if (e.key === "Delete" || e.key === "Backspace")
                    void workbench.run("editor.closeTab", {
                      groupId: group.id,
                      tabId: tab.id,
                    });
                }}
              >
                {tab.path ? (
                  <FileBadge path={tab.path} />
                ) : (
                  <Icon
                    name={
                      tab.id === "settings"
                        ? "gear"
                        : tab.id === "keyboard"
                          ? "keyboard"
                          : "package"
                    }
                    size={14}
                  />
                )}
                <span>{tab.path ? tab.title : tr(tab.title)}</span>
              </button>
              {tab.pinned ? (
                <IconButton
                  icon="pin"
                  label={tr("Unpin {0}", { "0": tab.title })}
                  onClick={() =>
                    void workbench.run("editor.pin", {
                      groupId: group.id,
                      tabId: tab.id,
                    })
                  }
                />
              ) : (
                <button
                  className="tab-close"
                  aria-label={tr("Close {0}", { "0": tab.title })}
                  onClick={() =>
                    void workbench.run("editor.closeTab", {
                      groupId: group.id,
                      tabId: tab.id,
                    })
                  }
                >
                  {doc?.dirty ? (
                    <span className="dirty-dot" />
                  ) : (
                    <Icon name="x" size={12} />
                  )}
                </button>
              )}
            </div>
          );
        })}
        <span className="push" />
        <div className="group-actions">
          {s.groups.length > 1 && (
            <select
              className="group-picker"
              aria-label={tr("Active editor group")}
              value={s.activeGroup}
              onChange={(event) =>
                workbench.set({ activeGroup: event.target.value })
              }
            >
              {s.groups.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {tr("Group {0}", { 0: index + 1 })}
                </option>
              ))}
            </select>
          )}
          <ToolbarContributions workbench={workbench} location="editor" />
          {current?.path?.endsWith(".md") && (
            <IconButton
              icon="eye"
              label={tr("Open Markdown preview")}
              onClick={() => void workbench.run("preview.markdown")}
            />
          )}
          <IconButton
            icon="splitR"
            label={tr("Split editor right")}
            onClick={() => {
              workbench.set({ activeGroup: group.id });
              void workbench.run("editor.splitRight");
            }}
          />
          <IconButton
            icon="more"
            label={tr("Editor actions")}
            onClick={(e) => {
              e.stopPropagation();
              workbench.set({
                menu: {
                  name: "context",
                  x: e.clientX - 250,
                  y: e.clientY + 10,
                  ids: [
                    "file.save",
                    "editor.format",
                    "editor.splitRight",
                    "editor.splitDown",
                    "editor.pin",
                    "editor.closeTab",
                    "editor.closeOthers",
                  ],
                },
              });
            }}
          />
        </div>
      </div>
      {failed ? (
        <EmptyState title={tr("Could not open file")}>
          <p role="alert">{failed}</p>
          <button className="button" onClick={() => setFailed(undefined)}>
            {tr("Retry")}
          </button>
        </EmptyState>
      ) : current ? (
        <DocumentView tab={current} group={group} workbench={workbench} />
      ) : (
        <div className="editor-empty">
          <div className="editor-watermark">Z</div>
          {[
            ["Go to File", "Ctrl P", "workbench.quickOpen"],
            ["Show All Commands", "Ctrl Shift P", "workbench.showCommands"],
            ["Search in Files", "Ctrl Shift F", "view.search"],
            ["New Terminal", "Ctrl Shift `", "terminal.new"],
          ].map(([title, key, id]) => (
            <button key={id} onClick={() => void workbench.run(id)}>
              <span>{tr(title)}</span>
              <kbd>{key}</kbd>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
function DocumentView({
  tab,
  group,
  workbench,
}: {
  tab: Tab;
  group: Group;
  workbench: WorkbenchController;
}) {
  const kernel = workbench.kernel;
  const doc = tab.path ? workbench.documents.get(tab.path) : undefined;
  const C = tab.component;
  if (C)
    return (
      <div className="document-view">
        <Boundary key={tab.id} name={tab.title}>
          <C
            kernel={kernel}
            workbench={workbench}
            documents={workbench.documents}
            {...tab.props}
          />
        </Boundary>
      </div>
    );
  if (tab.error || !doc)
    return (
      <EmptyState title={tr("Document unavailable")}>
        <p>{tab.path}</p>
        <p role="alert">{tab.error}</p>
        <button
          className="button"
          onClick={() =>
            tab.path && void workbench.openFile(tab.path, { groupId: group.id })
          }
        >
          {tr("Retry")}
        </button>
        {tab.path &&
          /ENOENT|NOT_FOUND|missing|not found|unavailable/i.test(
            tab.error || "",
          ) && (
            <button
              className="button"
              onClick={() =>
                void workbench.run("git.restore", { path: tab.path })
              }
            >
              {tr("Restore from Git")}
            </button>
          )}
      </EmptyState>
    );
  const contribution = kernel.contributions
    .list("documentView")
    .find((c) => (c.data as any)?.default);
  const Editor = contribution?.component;
  const conflict = doc.text.toString().includes("<<<<<<<");
  return (
    <div
      className="editor-document"
      onContextMenu={(event) => {
        event.preventDefault();
        workbench.activateTab(group.id, tab.id);
        workbench.set({
          menu: {
            name: "context",
            location: "editor",
            x: event.clientX,
            y: event.clientY,
            ids: [
              "editor.find",
              "editor.replace",
              "editor.format",
              "-",
              "editor.gotoDefinition",
              "editor.references",
              "editor.rename",
              "editor.codeAction",
              "-",
              "editor.selectAll",
            ],
          },
        });
      }}
    >
      <div className="breadcrumbs">
        {tab.path!.split("/").map((part, i, a) => (
          <span key={i}>
            {i > 0 && <Icon name="chevR" size={11} />}
            <button
              onClick={() =>
                i === a.length - 1
                  ? workbench.openPalette("symbols")
                  : void workbench.run("file.reveal")
              }
            >
              {part}
            </button>
          </span>
        ))}
      </div>
      {kernel.services.optional<RpcClient>("runtime") &&
        !kernel.services.optional<RpcClient>("runtime")?.connected && (
          <div className="document-banner" role="status">
            {tr("Runtime disconnected. Edits remain stored locally.")}
          </div>
        )}
      {doc.state !== "ready" && (
        <div
          className={`document-banner ${doc.state === "readonly" ? "" : "warning"}`}
          role="status"
        >
          <Icon name={doc.readonly ? "lock" : "warning"} />
          <span>
            {doc.error ||
              (doc.readonly
                ? tr("This file is read-only.")
                : doc.state === "conflict"
                  ? tr("File changed on disk. Review before saving.")
                  : tr("File {0}.", { 0: tr(doc.state) }))}
          </span>
          {doc.state === "conflict" && (
            <>
              <button
                onClick={async () => {
                  if (
                    doc.dirty &&
                    (await workbench.ask(
                      tr("Reload disk?"),
                      tr(
                        "Discard unsaved changes and reload the current file?",
                      ),
                      ["Reload", "Cancel"],
                      true,
                    )) !== "Reload"
                  )
                    return;
                  try {
                    await workbench.documents.reload(doc.path);
                  } catch (error) {
                    workbench.notify(String(error), "error");
                  }
                }}
              >
                {tr("Reload disk")}
              </button>
              <button
                onClick={() =>
                  void workbench.documents
                    .overwriteConflict(doc.path)
                    .catch((e) => workbench.notify(String(e), "error"))
                }
              >
                {tr("Keep mine")}
              </button>
              <button
                onClick={() =>
                  void workbench.run("git.compare", {
                    path: doc.path,
                    mode: "disk",
                  })
                }
              >
                {tr("Compare")}
              </button>
            </>
          )}
          {doc.state === "missing" && (
            <button
              onClick={() =>
                void workbench.run("git.restore", { path: doc.path })
              }
            >
              {tr("Restore from Git")}
            </button>
          )}
        </div>
      )}
      {conflict && (
        <div className="conflict-toolbar">
          <span>{tr("Merge conflict")}</span>
          {["Current", "Incoming", "Both"].map((choice) => (
            <button
              key={choice}
              onClick={() => {
                const text = doc.text
                  .toString()
                  .replace(
                    /^<<<<<<<[^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>>[^\n]*\n?/gm,
                    (_all, current: string, incoming: string) =>
                      choice === "Current"
                        ? current
                        : choice === "Incoming"
                          ? incoming
                          : current + incoming,
                  );
                doc.replace(text);
              }}
            >
              {tr("Accept {0}", { "0": tr(choice) })}
            </button>
          ))}
        </div>
      )}
      {Editor ? (
        <Boundary name="Code editor" key={doc.id + group.id}>
          <Editor
            handle={doc}
            kernel={kernel}
            workbench={workbench}
            viewId={group.id}
          />
        </Boundary>
      ) : (
        <EmptyState title={tr("Text editor extension disabled")}>
          <button
            className="button"
            onClick={() => void kernel.extensions.activate("zapp.editor")}
          >
            {tr("Enable editor")}
          </button>
        </EmptyState>
      )}
    </div>
  );
}
function CommandMenu({
  workbench,
  ids,
  location = "editor",
}: {
  workbench: WorkbenchController;
  ids: string[];
  location?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => prior?.focus();
  }, []);
  return (
    <div
      ref={ref}
      className="command-menu"
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const items = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
        );
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          items[
            (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
          ]?.focus();
        } else if (
          (e.key === "ArrowRight" || e.key === "ArrowLeft") &&
          Object.hasOwn(catalog.menus, location)
        ) {
          e.preventDefault();
          const menus = Object.keys(catalog.menus);
          workbench.set({
            menu: {
              name: menus[
                (menus.indexOf(location) +
                  (e.key === "ArrowRight" ? 1 : menus.length - 1)) %
                  menus.length
              ]!,
            },
          });
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          (e.key === "Home" ? items[0] : items.at(-1))?.focus();
        } else if (e.key === "Escape") {
          e.preventDefault();
          workbench.set({ menu: undefined });
        }
      }}
    >
      {[
        ...ids,
        ...(menuContributions(workbench.kernel, location).length
          ? [
              "-",
              ...menuContributions(workbench.kernel, location).map(
                (item) => "@" + item.id,
              ),
            ]
          : []),
      ].map((entry, i) => {
        const contribution = entry.startsWith("@")
          ? menuContributions(workbench.kernel, location).find(
              (item) => item.id === entry.slice(1),
            )
          : undefined;
        const id = contribution?.command || entry;
        if (id === "-") return <hr key={i} />;
        const cmd = workbench.kernel.commands.list().find((c) => c.id === id),
          info = catalog.commands.find((c) => c.id === id);
        const available =
          contribution && !workbench.kernel.context.matches(contribution.when)
            ? { enabled: false, reason: "Unavailable in this context" }
            : cmd
              ? workbench.kernel.commands.available(id)
              : { enabled: false, reason: "Extension unavailable" };
        return (
          <button
            role="menuitem"
            key={entry}
            aria-disabled={!available.enabled}
            title={available.reason}
            onClick={() => available.enabled && void workbench.run(id)}
          >
            <span>
              {tr(contribution?.title || cmd?.title || info?.title || id)}
            </span>
            <kbd>
              {displayShortcut(
                workbench.state.keybindings[id] ??
                  cmd?.shortcut ??
                  info?.win ??
                  "",
              )}
            </kbd>
            {!available.enabled && <small>{available.reason}</small>}
          </button>
        );
      })}
    </div>
  );
}
function Palette({ workbench }: { workbench: WorkbenchController }) {
  const s = useWorkbench(workbench),
    palette = s.palette!;
  const [index, setIndex] = useState(0),
    [symbols, setSymbols] = useState<any[]>([]);
  const [fileResults, setFileResults] = useState<{
    query: string;
    paths: string[];
  }>({ query: "", paths: [] });
  const ref = useRef<HTMLInputElement>(null),
    prior = useRef<HTMLElement | null>(null);
  useEffect(() => {
    prior.current = document.activeElement as HTMLElement;
    ref.current?.focus();
    return () => prior.current?.focus();
  }, []);
  const query = palette.query;
  const mode =
    query.startsWith(">") || query.startsWith("›")
      ? "commands"
      : query.startsWith("@")
        ? "symbols"
        : query.startsWith(":")
          ? "line"
          : palette.mode === "recent"
            ? "recent"
            : "files";
  const term = query
    .replace(/^[>›@:]/, "")
    .trim()
    .toLowerCase();
  useEffect(() => {
    if (mode !== "files" || !term) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void findWorkspaceFiles(workbench.filesystem, term, controller.signal)
        .then((paths) => {
          if (!controller.signal.aborted) setFileResults({ query: term, paths });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            workbench.notify(String(error), "error");
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode, term, workbench]);
  useEffect(() => {
    setIndex(0);
  }, [query]);
  useEffect(() => {
    if (mode !== "symbols") return;
    const path = workbench.activePath(),
      service = workbench.kernel.services.optional<any>("language");
    if (service && path)
      void service
        .request("textDocument/documentSymbol", {
          textDocument: { uri: service.uri(path) },
        })
        .then((values: any[]) => {
          const flatten = (items: any[]): any[] =>
            items.flatMap((item) => [item, ...flatten(item.children || [])]);
          setSymbols(flatten(values || []));
        })
        .catch(() => setSymbols([]));
  }, [mode, workbench]);
  const score = (text: string) => {
    const v = text.toLowerCase();
    if (!term) return 1;
    const start = v.indexOf(term);
    if (start >= 0) return 1000 - start;
    let at = 0,
      points = 0;
    for (const char of term) {
      const found = v.indexOf(char, at);
      if (found < 0) return 0;
      points += found === at ? 4 : 1;
      at = found + 1;
    }
    return points;
  };
  const rows: {
    id: string;
    title: string;
    detail?: string;
    keys?: string;
    enabled: boolean;
    run: () => unknown;
    icon?: string;
  }[] =
    mode === "commands"
      ? workbench.kernel.commands
          .list()
          .map((c) => ({
            id: c.id,
            title: c.title,
            detail: c.category,
            keys:
              s.keybindings[c.id] ??
              c.shortcut ??
              catalog.commands.find((i) => i.id === c.id)?.win,
            enabled: workbench.kernel.commands.available(c.id).enabled,
            run: () => workbench.run(c.id),
          }))
          .filter((r) => score(tr(r.title) + " " + r.title + " " + r.id) > 0)
          .sort((a, b) => score(tr(b.title)) - score(tr(a.title)))
      : mode === "symbols"
        ? symbols
            .filter((item) => score(item.name) > 0)
            .map((item, i) => ({
              id: String(i),
              title: item.name,
              detail: "Symbol",
              icon: "symbol",
              enabled: true,
              run: () =>
                workbench.openFile(workbench.activePath()!, {
                  line:
                    (item.selectionRange || item.range || item.location?.range)
                      .start.line + 1,
                  col:
                    (item.selectionRange || item.range || item.location?.range)
                      .start.character + 1,
                }),
            }))
        : mode === "line"
          ? [
              {
                id: "line",
                title: `Go to line ${term || "1"}`,
                detail: "Enter line[:column]",
                enabled: /^\d*(?::\d*)?$/.test(term),
                run: () =>
                  workbench.activePath() &&
                  workbench.openFile(workbench.activePath()!, {
                    line: Number(term.split(":")[0]) || 1,
                    col: Number(term.split(":")[1]) || 1,
                  }),
              },
            ]
          : (mode === "recent"
              ? s.recent
              : [
                  ...new Set([
                    ...s.recent,
                    ...s.files.filter((f) => f.kind === "file").map((f) => f.path),
                    ...(mode === "files" && term && fileResults.query === term
                      ? fileResults.paths
                      : []),
                  ]),
                ]
            )
              .filter((p) => score(p) > 0)
              .sort((a, b) => score(b) - score(a))
              .map((path) => ({
                id: path,
                title: path.split("/").pop() || path,
                detail: path,
                enabled: true,
                run: () => workbench.openFile(path, { preview: false }),
              }));
  const selected = Math.max(0, Math.min(index, Math.min(rows.length, 100) - 1));
  useEffect(() => {
    document
      .getElementById(`palette-option-${selected}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const run = (row: (typeof rows)[number]) => {
    if (!row.enabled) return;
    workbench.set({ palette: undefined });
    void Promise.resolve(row.run()).catch((e) =>
      workbench.notify(String(e), "error"),
    );
  };
  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) workbench.set({ palette: undefined });
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={tr("Quick Open")}
      >
        <div className="palette-input">
          <input
            ref={ref}
            value={query}
            aria-label={tr("Search files and commands")}
            aria-autocomplete="list"
            aria-controls="palette-list"
            aria-activedescendant={`palette-option-${selected}`}
            role="combobox"
            aria-expanded="true"
            placeholder={tr(
              "Search files by name; > commands, @ symbols, : line",
            )}
            onChange={(e) =>
              workbench.set({ palette: { ...palette, query: e.target.value } })
            }
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setIndex(
                  (n) =>
                    (n +
                      (e.key === "ArrowDown"
                        ? 1
                        : Math.min(rows.length, 100) - 1)) %
                    Math.max(1, Math.min(rows.length, 100)),
                );
              }
              if (e.key === "Enter") {
                e.preventDefault();
                if (rows[selected]) run(rows[selected]);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                workbench.set({ palette: undefined });
              }
            }}
          />
          <IconButton
            icon="x"
            label={tr("Close palette")}
            onClick={() => workbench.set({ palette: undefined })}
          />
        </div>
        <div className="palette-label">
          {mode === "commands"
            ? tr("Commands")
            : mode === "symbols"
              ? tr("Symbols in current file")
              : mode === "line"
                ? tr("Go to Line")
                : mode === "recent"
                  ? tr("Recent files")
                  : tr("Files")}
        </div>
        <div role="listbox" id="palette-list" className="palette-results">
          {rows.slice(0, 100).map((row, i) => (
            <button
              key={row.id}
              id={`palette-option-${i}`}
              role="option"
              aria-selected={i === selected}
              aria-disabled={!row.enabled}
              className={i === selected ? "selected" : ""}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(row)}
            >
              {mode === "files" || mode === "recent" ? (
                <FileBadge path={row.id} />
              ) : (
                <Icon name={row.icon || "goto"} size={14} />
              )}
              <span>
                {tr(row.title)}
                <small>{row.detail ? tr(row.detail) : undefined}</small>
              </span>
              <kbd>{displayShortcut(row.keys)}</kbd>
              {!row.enabled && <small>{tr("Unavailable")}</small>}
            </button>
          ))}
          {!rows.length && (
            <div className="empty-state">
              {mode === "symbols"
                ? tr("No language server symbols available.")
                : tr("No results found.")}
            </div>
          )}
        </div>
        <div className="palette-footer">
          <span>{tr("↑↓ navigate")}</span>
          <span>{tr("↵ open")}</span>
          <span>{tr("Esc close")}</span>
          <span className="push">
            {rows.length} {tr("results")}
          </span>
        </div>
      </div>
    </div>
  );
}
function WorkbenchDialog({ workbench }: { workbench: WorkbenchController }) {
  const dialog = workbench.state.dialog!;
  const [value, setValue] = useState(dialog.value || "");
  const close = useCallback(() => workbench.finishDialog(), [workbench]);
  return (
    <Dialog title={dialog.title} danger={dialog.danger} onClose={close}>
      {dialog.message && <p>{tr(dialog.message)}</p>}
      {dialog.input && (
        <input
          aria-label={dialog.title}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter")
              workbench.finishDialog(dialog.choices[0], value);
          }}
        />
      )}
      <div className="dialog-actions">
        {dialog.choices.map((choice, i) => (
          <button
            key={choice}
            className={`button ${i === 0 ? (dialog.danger ? "danger" : "primary") : ""}`}
            onClick={() => workbench.finishDialog(choice, value)}
          >
            {tr(choice)}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
function Notifications({ workbench }: { workbench: WorkbenchController }) {
  const s = useWorkbench(workbench);
  const [, update] = useState(0);
  const center = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!s.notificationCenter) return;
    const prior = document.activeElement as HTMLElement | null;
    center.current?.querySelector<HTMLElement>("button")?.focus();
    return () => prior?.focus();
  }, [s.notificationCenter]);
  useEffect(() => {
    const deadlines = s.notifications
      .filter((notification) => notification.ttl !== 0)
      .map(
        (notification) =>
          notification.time + (notification.ttl ?? 6500) - Date.now(),
      )
      .filter((delay) => delay > 0);
    if (!deadlines.length) return;
    const id = setTimeout(
      () => update((value) => value + 1),
      Math.min(...deadlines) + 1,
    );
    return () => clearTimeout(id);
  });
  if (s.notificationCenter)
    return (
      <aside
        ref={center}
        className="notification-center"
        aria-label={tr("Notifications")}
      >
        <div className="sidebar-heading">
          {tr("Notifications")}
          <span className="push" />
          <button onClick={() => workbench.set({ notifications: [] })}>
            {tr("Clear all")}
          </button>
          <IconButton
            icon="x"
            label={tr("Close notifications")}
            onClick={() => workbench.set({ notificationCenter: false })}
          />
        </div>
        {s.notifications.length ? (
          s.notifications
            .slice()
            .reverse()
            .map((n) => (
              <div className={`notification ${n.type}`} key={n.id}>
                <Icon
                  name={
                    n.type === "error"
                      ? "error"
                      : n.type === "warning"
                        ? "warning"
                        : "info"
                  }
                />
                <span>
                  {n.source && <small>{n.source}</small>}
                  {tr(n.message)}
                  <NotificationActions notification={n} workbench={workbench} />
                  <small>{new Date(n.time).toLocaleTimeString()}</small>
                </span>
                <IconButton
                  icon="x"
                  label={tr("Dismiss notification")}
                  onClick={() =>
                    workbench.set({
                      notifications: s.notifications.filter(
                        (x) => x.id !== n.id,
                      ),
                    })
                  }
                />
              </div>
            ))
        ) : (
          <div className="empty-state">{tr("No notifications")}</div>
        )}
      </aside>
    );
  return (
    <div className="toasts" aria-live="polite">
      {s.notifications
        .filter((n) => n.ttl === 0 || Date.now() - n.time < (n.ttl ?? 6500))
        .slice(innerWidth < 600 ? -1 : -3)
        .map((n) => (
          <div
            className={`notification ${n.type}`}
            role={n.type === "error" ? "alert" : "status"}
            key={n.id}
          >
            <Icon
              name={
                n.type === "error"
                  ? "error"
                  : n.type === "warning"
                    ? "warning"
                    : "info"
              }
            />
            <span>
              {n.source && <small>{n.source}</small>}
              {tr(n.message)}
              <NotificationActions notification={n} workbench={workbench} />
            </span>
            <IconButton
              icon="x"
              label={tr("Dismiss notification")}
              onClick={() =>
                workbench.set({
                  notifications: s.notifications.filter((x) => x.id !== n.id),
                })
              }
            />
          </div>
        ))}
    </div>
  );
}

function EditorStatus({ workbench }: { workbench: WorkbenchController }) {
  const [, render] = useState(0);
  useEffect(() => {
    const selection = workbench.kernel.events.on("editor.selection", () =>
      render((value) => value + 1),
    );
    return () => selection.dispose();
  }, [workbench]);
  const path = workbench.activePath();
  const doc = path ? workbench.documents.get(path) : undefined;
  if (!doc) return null;
  const editor = workbench.activeEditor();
  const selected = editor?.state.selection.main;
  const line = selected ? editor!.state.doc.lineAt(selected.head) : undefined;
  return (
    <>
      <button onClick={() => workbench.openPalette("line")}>
        {tr("Ln")} {line?.number || 1}
        {tr(", Col")} {selected && line ? selected.head - line.from + 1 : 1}
        {editor && editor.state.selection.ranges.length > 1
          ? tr(" ({0} cursors)", { 0: editor.state.selection.ranges.length })
          : ""}
      </button>
      <button onClick={() => void workbench.run("settings.open")}>
        {tr("Spaces:")}{" "}
        {workbench.kernel.configuration.get<number>(
          "editor.tabSize",
          path ? languageIdForPath(path) : undefined,
        )}
      </button>
      <button onClick={() => void chooseEncoding(workbench)}>
        {doc.encoding.toUpperCase()}
      </button>
      <button
        onClick={() => {
          doc.eol = doc.eol === "LF" ? "CRLF" : "LF";
          workbench.documentChanged();
        }}
      >
        {doc.eol}
      </button>
      <span>
        {(catalog.langMeta as Record<string, { label: string }>)[
          path!.split(".").pop() || "txt"
        ]?.label || tr("Plain Text")}
      </span>
    </>
  );
}
function ToolbarContributions({
  workbench,
  location,
}: {
  workbench: WorkbenchController;
  location: string;
}) {
  return (
    <>
      {workbench.kernel.contributions
        .list("toolbar")
        .filter((item) => item.location === location)
        .map((item) => {
          const enabled =
            workbench.kernel.context.matches(item.when) &&
            (!item.command ||
              workbench.kernel.commands.available(item.command).enabled);
          const C = item.component;
          return C ? (
            <Boundary key={item.id} name={item.title}>
              <C workbench={workbench} kernel={workbench.kernel} />
            </Boundary>
          ) : (
            <button
              key={item.id}
              title={tr(item.title)}
              disabled={!enabled}
              onClick={() => item.command && void workbench.run(item.command)}
            >
              {(item.data as { icon?: string })?.icon ? (
                <Icon name={(item.data as { icon: string }).icon} />
              ) : (
                tr(item.title)
              )}
            </button>
          );
        })}
    </>
  );
}

function GroupSash({
  workbench,
  index,
}: {
  workbench: WorkbenchController;
  index: number;
}) {
  const groups = workbench.state.groups;
  const row = workbench.state.direction === "row";
  const change = (delta: number) => {
    const a = groups[index - 1]!,
      b = groups[index]!;
    const total = (a.size || 1) + (b.size || 1);
    const size = Math.max(
      total * 0.15,
      Math.min(total * 0.85, (a.size || 1) + delta),
    );
    workbench.set({
      groups: workbench.state.groups.map((group, i) =>
        i === index - 1
          ? { ...group, size }
          : i === index
            ? { ...group, size: total - size }
            : group,
      ),
    });
  };
  return (
    <div
      className="group-sash"
      role="separator"
      aria-label={tr("Resize editor groups")}
      aria-orientation={row ? "vertical" : "horizontal"}
      tabIndex={0}
      onKeyDown={(event) => {
        if (
          (row
            ? ["ArrowLeft", "ArrowRight"]
            : ["ArrowUp", "ArrowDown"]
          ).includes(event.key)
        ) {
          event.preventDefault();
          change(["ArrowRight", "ArrowDown"].includes(event.key) ? 0.1 : -0.1);
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const start = row ? event.clientX : event.clientY;
        const bounds =
          event.currentTarget.parentElement!.getBoundingClientRect();
        const length = row ? bounds.width : bounds.height;
        const total = groups.reduce((sum, group) => sum + (group.size || 1), 0);
        const move = (next: PointerEvent) =>
          change(
            (((row ? next.clientX : next.clientY) - start) / length) * total,
          );
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
        window.addEventListener("pointercancel", up, { once: true });
      }}
    />
  );
}

function NotificationActions({
  notification,
  workbench,
}: {
  notification: Notification;
  workbench: WorkbenchController;
}) {
  return notification.actions?.length ? (
    <div className="notification-actions">
      {notification.actions.slice(0, 3).map((action, index) => (
        <button
          key={index}
          className="text-button"
          disabled={
            !workbench.kernel.commands.available(action.command).enabled
          }
          onClick={() => void workbench.run(action.command, action.args)}
        >
          {tr(action.title)}
        </button>
      ))}
    </div>
  ) : null;
}

function GitBranch({ workbench }: { workbench: WorkbenchController }) {
  const [, refresh] = useState(0);
  const git = workbench.kernel.services.optional<{
    status?: () => { branch: string };
    subscribe?: (listener: () => void) => () => void;
  }>("git");
  useEffect(() => git?.subscribe?.(() => refresh((value) => value + 1)), [git]);
  return (
    <button onClick={() => void workbench.run("git.checkout")}>
      <Icon name="git" size={13} />
      <span>{git?.status?.().branch || tr("Branch")}</span>
    </button>
  );
}
