import * as ReactHost from "react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  native,
  ProjectSessionManager,
  type CloseRequest,
  type ToolStatus,
  type UpdateStatus,
} from "@oxbit/host-desktop";
import type { Session } from "@oxbit/app-workbench";
import { configurePanelWindows, currentTheme, PanelProvider, Workbench, workspaceEntries, themeMode, themeVariables } from "@oxbit/workbench";
import { Dialog, OxbitMark, setLocale, installTextInputPolicy } from "@oxbit/ui";
import { ProjectMenu } from "./project-menu.js";
import "@oxbit/ui/tokens.css";
import "@oxbit/ui/workbench.css";
import "./desktop.css";
import { SshDialog } from "./ssh-dialog.js";

(globalThis as any).__OXBIT_REACT__ = ReactHost;
installTextInputPolicy(document);
if (import.meta.env.VITE_DESKTOP_TEST === "1")
  await import("@wdio/tauri-plugin");
const manager = new ProjectSessionManager();
const windowEvents = { target: getCurrentWebviewWindow().label };
// Native clipboard and system-browser routing also serve existing workbench features.
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: (text: string) => native.clipboard(text).then(() => {}),
    readText: () => native.clipboard(),
  },
});
// Keep related panel windows in the native webview, sharing their opener's session.
const openPanelWindow = window.open.bind(window);
configurePanelWindows({
  pointerDrag: true,
  close: (id) => native.closePanel(id),
  open: (_url, name, features) => {
    // A related blank window inherits the opener's origin and needs no app bootstrap.
    const child = openPanelWindow("about:blank#oxbit-panel=" + name, name, features);
    if (child) {
      child.document.title = "Oxbit — Panels";
      child.document.body.dataset.oxbitPanelShell = "true";
      const root = child.document.createElement("div");
      root.id = "panel-root";
      child.document.body.append(root);
    }
    return child;
  },
  restoreAutomatically: true,
});
window.open = ((url?: string | URL) => {
  if (url) void native.external(String(url));
  return null;
}) as typeof window.open;
document.addEventListener("click", (event) => {
  const anchor = (event.target as Element)?.closest?.(
    "a[href]",
  ) as HTMLAnchorElement | null;
  if (anchor && ["https:", "http:", "mailto:"].includes(anchor.protocol)) {
    event.preventDefault();
    void native.external(anchor.href);
  }
});

function App() {
  const view = useSyncExternalStore(manager.subscribe, manager.snapshot);
  const active = manager.active;
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"trust" | "tools" | "update" | "ssh">();
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [update, setUpdate] = useState<UpdateStatus>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const discardOnClose = useRef(false);
  const pendingClose = useRef<string | undefined>(undefined);
  const [close, setClose] = useState<{
    request: CloseRequest;
    dirty: string[];
    tools: number;
    waiting?: boolean;
    discard?: boolean;
  }>();
  const perform = (operation: Promise<unknown>) => {
    void operation.catch((e) => setError(String(e)));
  };
  const checkUpdates = async (startup = false) => {
    try {
      const result = await native.checkUpdate();
      setUpdate(result);
      if (!startup || result.status === "available") setPanel("update");
    } catch (e) {
      if (!startup) setError(String(e));
    }
  };
  const showTools = async (checkAuth = false) => {
    setPanel("tools");
    setBusy(true);
    try {
      setTools(await native.tools(checkAuth));
    } finally {
      setBusy(false);
    }
  };
  const action = async (id: string) => {
    if (manager.isClosing) return;
    const current = manager.active;
    switch (id) {
      case "desktop:remote":
        setPanel("ssh");
        break;
      case "desktop:open":
        await native.open();
        break;
      case "desktop:open-file":
        await native.open(undefined, false, true);
        break;
      case "desktop:open-new":
        await native.open(undefined, true);
        break;
      case "desktop:move":
        if (current) await manager.move(current.project.key);
        break;
      case "desktop:close-project":
        if (current) await native.close("project", current.project.key);
        break;
      case "desktop:close-window":
        await native.close("window");
        break;
      case "desktop:quit":
        await native.close("quit");
        break;
      case "desktop:tools":
        await showTools();
        break;
      case "desktop:updates":
        await checkUpdates();
        break;
      default:
        await current?.session?.workbench.run(id);
    }
  };
  useEffect(() => {
    const off: (() => void)[] = [];
    let stopped = false;
    const add = (dispose: () => void) => {
      if (stopped) dispose();
      else off.push(dispose);
    };
    void (async () => {
      add(await listen<{ key: string; message: string }>("desktop-remote-progress", ({ payload }) => setProgress(payload.message)));
      add(
        await listen<string>("desktop-error", ({ payload }) =>
          setError(payload),
        ),
      );
      add(
        await listen<string>(
          "desktop-menu",
          ({ payload }) => perform(action(payload)),
          windowEvents,
        ),
      );
      add(
        await listen<CloseRequest>(
          "desktop-prepare-close",
          ({ payload }) => {
            void getCurrentWebviewWindow().setFocus();
            setPanel(undefined);
            discardOnClose.current = false;
            pendingClose.current = payload.id;
            void manager
              .prepare(payload)
              .then((summary) => {
                if (pendingClose.current !== payload.id) return;
                setClose({ request: payload, ...summary });
                if (!summary.dirty.length && !summary.tools) {
                  setClose({ request: payload, ...summary, waiting: true });
                  return native.vote(payload.id, true);
                }
              })
              .catch(async (e) => {
                if (pendingClose.current !== payload.id) return;
                setError(String(e));
                manager.cancelClose();
                await native.vote(payload.id, false);
              });
          },
          windowEvents,
        ),
      );
      add(
        await listen("desktop-close-completed", () => {
          pendingClose.current = undefined;
          setClose(undefined);
          manager.cancelClose();
        }),
      );
      add(
        await listen("desktop-close-cancelled", () => {
          pendingClose.current = undefined;
          setClose(undefined);
          manager.cancelClose();
        }),
      );
      add(
        await listen<{ downloaded: number; total?: number }>(
          "desktop-update-progress",
          ({ payload }) =>
            setProgress(
              payload.total
                ? `${Math.round((payload.downloaded / payload.total) * 100)}%`
                : `${Math.round(payload.downloaded / 1048576)} MB`,
            ),
        ),
      );
      await manager.start();
      await checkUpdates(true);
    })().catch((e) => setError(String(e)));
    return () => {
      stopped = true;
      for (const dispose of off) dispose();
    };
  }, []);
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen<{ id: string; keys: string[] }>(
      "desktop-commit-close",
      ({ payload }) => {
        if (pendingClose.current !== payload.id) return;
        void (async () => {
          try {
            await manager.commitClose(payload.keys, discardOnClose.current);
            if (pendingClose.current !== payload.id) {
              if (!pendingClose.current) manager.cancelClose();
              return;
            }
            await native.finished(payload.id);
            setClose(undefined);
          } catch (e) {
            setError(String(e));
            setClose(undefined);
            manager.cancelClose();
            await native.finished(payload.id, String(e)).catch(() => {});
          }
        })();
      },
      windowEvents,
    ).then((dispose) => {
      if (cancelled) dispose();
      else off = dispose;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        manager.isClosing ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey
      )
        return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        event.stopImmediatePropagation();
        perform(native.open(undefined, false, event.shiftKey));
      }
      if (event.key === "Tab" && view.projects.length > 1 && !close) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const index = view.projects.findIndex(
          (p) => p.project.key === view.active,
        );
        const next =
          view.projects[
            (index + (event.shiftKey ? -1 : 1) + view.projects.length) %
              view.projects.length
          ];
        perform(manager.activate(next.project.key));
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => window.removeEventListener("keydown", keyboard, true);
  }, [view.active, view.projects, close]);
  useEffect(() => {
    const session = active?.session;
    if (!session) return;
    const registrations = [
      ["workspace.open", "Open Folder…", () => native.open()],
      ["workspace.connectSsh", "Connect over SSH…", () => setPanel("ssh")],
      [
        "workspace.switch",
        "Switch Project",
        () => {
          session.workbench.set({ focus: false });
          requestAnimationFrame(() => document.getElementById("project-switcher")?.click());
        },
      ],
      [
        "workspace.close",
        "Close Project",
        () => native.close("project", active.project.key),
      ],
      [
        "desktop.openNewWindow",
        "Open in New Window…",
        () => native.open(undefined, true),
      ],
      [
        "desktop.moveProject",
        "Move Project to New Window",
        () => manager.move(active.project.key),
      ],
      ["desktop.tools", "Developer Tools", () => showTools()],
      ["desktop.checkUpdates", "Check for Updates", () => checkUpdates()],
      [
        "desktop.reveal",
        /Mac/.test(navigator.platform) ? "View in Finder" : "View in File Explorer",
        (args?: unknown) =>
          native.reveal(
            active.project.key,
            (args as { path?: string } | undefined)?.path ?? session.workbench.activePath() ?? "",
          ),
      ],
      [
        "workspace.export",
        "Export Workspace…",
        () => exportWorkspace(active.project.key, session),
      ],
      [
        "workspace.import",
        "Import Workspace…",
        () => importWorkspace(active.project.key, session),
      ],
    ] as const;
    const disposables = registrations.map(([id, title, run]) =>
      session.kernel.commands.register({ id, title, category: "Desktop", run }),
    );
    if (!active.project.path.startsWith("ssh://")) {
      for (const location of ["explorer", "tab", "editor"]) {
        disposables.push(session.kernel.contributions.register({
          id: `desktop.reveal.${location}`, kind: "menu", location,
          title: /Mac/.test(navigator.platform) ? "View in Finder" : "View in File Explorer",
          command: "desktop.reveal",
        }));
      }
    }
    session.workbench.touch();
    if (import.meta.env.VITE_DESKTOP_TEST === "1")
      (globalThis as any).__oxbit = {
        ...session,
        ready: true,
        manager,
        native,
        openFile: (path: string) =>
          session.workbench.openFile(path, { preview: false }),
      };
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [active?.session]);
  if (import.meta.env.VITE_DESKTOP_TEST === "1")
    (globalThis as any).__oxbitDesktop = { manager, native };
  const theme = active?.session ? themeMode(active.session.kernel) : 'dark';
  useSyncExternalStore<unknown>(active?.session?.workbench.subscribe ?? (()=>()=>{}), active?.session?.workbench.snapshot ?? (()=>0));
  const projectMenu = (
    <ProjectMenu
      view={view}
      disabled={manager.isClosing}
      onActivate={(key) => perform(manager.activate(key))}
      onOpen={(newWindow) => perform(native.open(undefined, newWindow))}
      onConnectSsh={() => setPanel("ssh")}
      onMove={active ? () => perform(manager.move(active.project.key)) : undefined}
      onOpenBehaviorChange={(value) => perform(native.settings([
        { path: ["user", "desktop.projects.openBehavior"], value },
      ]))}
    />
  );
  return (
    <div className="desktop-shell" style={active?.session ? themeVariables(active.session.kernel) : undefined} data-theme={theme} data-theme-pack={active?.session ? currentTheme(active.session.kernel).packId : undefined} data-density="compact">
      {!active?.session && (
        <header className="titlebar" role="menubar" aria-label="Application menu" inert={manager.isClosing}>
          <div className="brand" role="img" aria-label="Oxbit">
            <OxbitMark decorative />
          </div>
          {projectMenu}
        </header>
      )}
      {error && (
        <div className="desktop-alert" role="alert">
          <span>{error}</span>
          <button className="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      {active?.error && (
        <div className="desktop-alert" role="alert">
          <span>{active.error}</span>
          <button
            className="button"
            onClick={() => perform(manager.restart(active.project.key))}
          >
            {active.project.path.startsWith("ssh://") ? "Reconnect over SSH" : "Restart Runtime"}
          </button>
          <button
            className="button"
            onClick={() => perform(native.close("project", active.project.key))}
          >
            Close Project
          </button>
        </div>
      )}
      <main className="desktop-content" inert={manager.isClosing}>
        {view.projects.filter(entry => entry.session).map(entry => (
          <ProjectPanels key={entry.project.key} entry={entry} active={entry.project.key === active?.project.key}>
            {entry.project.key === active?.project.key && <ActiveWorkbench
              session={entry.session!}
              onConnect={() => setPanel("trust")}
              onOpenWorkspace={() => perform(native.open())}
              workspaceControl={projectMenu}
            />}
          </ProjectPanels>
        ))}
        {!active?.session && (
          <div className="desktop-welcome">
            <div className="oxbit-logo" role="img" aria-label="Oxbit" />
            <h1>
              {active?.loading && active.project.path.startsWith("ssh://")
                ? "Connecting to your remote workspace…"
                : view.loading || active?.loading
                ? "Opening your projects…"
                : active?.error
                  ? "Project unavailable"
                  : "Open a folder to start"}
            </h1>
            <p role="status">{(view.loading || active?.loading) && progress ? progress : "Your files, editor, and developer tools in one place."}</p>
            <button
              className="button primary"
              onClick={() => perform(native.open())}
            >
              Open Folder…
            </button>
            <button
              className="text-button"
              onClick={() => perform(showTools())}
            >
              Developer Tools
            </button>
            {!!view.recent.length && (
              <section aria-label="Recent projects">
                <h2>Recent projects</h2>
                {view.recent.map((path) => (
                  <button
                    className="recent-item"
                    key={path}
                    onClick={() => perform(native.open(path))}
                  >
                    {path}
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
      </main>
      {panel === "ssh" && <SshDialog onClose={() => setPanel(undefined)} onConnect={async target => {
        await native.openRemote(target);
        setPanel(undefined);
      }} />}
      {panel === "trust" && active?.session && (
        <div className="runtime-connect">
          <TrustDialog
            session={active.session}
            close={() => setPanel(undefined)}
          />
        </div>
      )}
      {panel === "tools" && (
        <Dialog title="Developer Tools" onClose={() => setPanel(undefined)}>
          <p>
            Editing works without Git or GitHub CLI. Authentication is checked
            only when requested.
          </p>
          {tools.map((tool) => (
            <section key={tool.name}>
              <h2>{tool.name}</h2>
              <p>
                {tool.version ?? "Not available"}
                <br />
                <code>{tool.path ?? "No executable found"}</code>
              </p>
              {tool.authenticated !== null &&
                tool.authenticated !== undefined && (
                  <p>
                    {tool.authenticated
                      ? "GitHub authentication is available."
                      : "No working GitHub authentication was found."}
                  </p>
                )}
              <p>{tool.guidance}</p>
            </section>
          ))}
          <button
            className="button"
            disabled={busy}
            onClick={() => perform(showTools(true))}
          >
            {busy ? "Checking…" : "Check GitHub Authentication"}
          </button>
          {active?.session && (
            <button
              className="button"
              disabled={busy || !active.session.runtime?.session?.trusted}
              onClick={() => perform(startGhLogin(active.session!))}
            >
              Sign In with gh in Terminal
            </button>
          )}
        </Dialog>
      )}
      {panel === "update" && (
        <Dialog
          title="Oxbit Updates"
          onClose={() => {
            if (!busy) setPanel(undefined);
          }}
        >
          <p>
            {update?.status === "available"
              ? `Oxbit ${update.version} is available.`
              : update?.status === "manual"
                ? "Upgrade this installation by downloading the latest package."
                : update?.status === "unconfigured"
                  ? "Updates are unavailable in this unsigned development build."
                  : "You’re up to date."}
          </p>
          {update?.notes && <p>{update.notes}</p>}
          {update?.status === "available" && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                perform(native.downloadUpdate().finally(() => setBusy(false)));
              }}
            >
              {busy ? `Downloading ${progress}` : "Download and Install…"}
            </button>
          )}
          {update?.url && (
            <button
              className="button"
              onClick={() => perform(native.external(update.url!))}
            >
              View Downloads
            </button>
          )}
        </Dialog>
      )}
      {close && (
        <Dialog
          title={
            close.request.reason === "update"
              ? "Restart to update Oxbit?"
              : "Close projects?"
          }
          onClose={() => perform(native.vote(close.request.id, false))}
        >
          {close.waiting ? (
            <p>Waiting for all windows to finish saving…</p>
          ) : (
            <>
              <p>
                {close.dirty.length
                  ? `${close.dirty.length} unsaved document${close.dirty.length === 1 ? "" : "s"}.`
                  : "All documents are saved."}
              </p>
              {!!close.dirty.length && (
                <ul className="desktop-dirty-list">
                  {close.dirty.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              )}
              {!!close.tools && (
                <p>
                  {close.tools} active terminal
                  {close.tools === 1 ? " or task" : "s or tasks"} will be
                  stopped.
                </p>
              )}
            </>
          )}
          <div className="dialog-actions">
            <button
              className="button"
              onClick={() => perform(native.vote(close.request.id, false))}
            >
              Cancel
            </button>
            {!close.waiting && (
              <>
                <button
                  className="button"
                  onClick={() => {
                    discardOnClose.current = true;
                    setClose({ ...close, discard: true, waiting: true });
                    perform(native.vote(close.request.id, true));
                  }}
                >
                  Discard
                </button>
                <button
                  className="button primary"
                  onClick={() =>
                    perform(
                      (async () => {
                        await manager.saveAll(close.request.keys);
                        if (pendingClose.current !== close.request.id) return;
                        setClose({ ...close, waiting: true, discard: false });
                        await native.vote(close.request.id, true);
                      })(),
                    )
                  }
                >
                  Save All
                </button>
              </>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
function ProjectPanels({ entry, active, children }: { entry: ReturnType<typeof manager.snapshot>["projects"][number]; active: boolean; children: ReactNode }) {
  const workbench = entry.session!.workbench;
  useEffect(() => {
    workbench.panelWindows.activateOwner = () => { if (manager.active?.project.key !== entry.project.key) void native.activate(entry.project.key); };
    return () => { workbench.panelWindows.activateOwner = undefined; };
  }, [workbench, entry.project.key]);
  return <PanelProvider workbench={workbench} active={active}>{children}</PanelProvider>;
}
function ActiveWorkbench({
  session,
  onConnect,
  onOpenWorkspace,
  workspaceControl,
}: {
  session: Session;
  onConnect: () => void;
  onOpenWorkspace: () => void;
  workspaceControl: ReactNode;
}) {
  useSyncExternalStore(session.workbench.subscribe, session.workbench.snapshot);
  setLocale(session.kernel.configuration.get<string>("workbench.locale"));
  return (
    <Workbench
      workbench={session.workbench}
      runtime={session.runtime}
      onConnect={onConnect}
      onOpenWorkspace={onOpenWorkspace}
      workspaceControl={workspaceControl}
    />
  );
}
function TrustDialog({
  session,
  close,
}: {
  session: Session;
  close: () => void;
}) {
  const [trusted, setTrusted] = useState(!!session.runtime?.session?.trusted);
  const [error, setError] = useState("");
  return (
    <Dialog title="Workspace tools" onClose={close}>
      <p>
        Opening a folder enables editing. Trust this project to run terminals,
        tasks, Git, language services, and runtime extensions.
      </p>
      <p>
        {trusted
          ? "This project is trusted."
          : "This project’s tools are disabled."}
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        className="button primary"
        onClick={() =>
          void session.runtime
            ?.trust(!trusted)
            .then(() => setTrusted(!trusted))
            .catch((error) => setError(String(error)))
        }
      >
        {trusted ? "Revoke Workspace Tool Trust" : "Trust Workspace Tools"}
      </button>
    </Dialog>
  );
}
async function startGhLogin(session: Session) {
  const gh = (await native.tools()).find((tool) => tool.name === "gh")?.path;
  if (!gh)
    throw new Error(
      "Install GitHub CLI or configure its executable path in Desktop settings",
    );
  await session.workbench.run("terminal.new");
  const sessions =
    await session.runtime!.request<{ id: string; exitCode?: number }[]>(
      "terminal.list",
    );
  const terminal = sessions
    .filter((item) => item.exitCode === undefined)
    .at(-1);
  if (!terminal) throw new Error("Open a trusted terminal first");
  await session.runtime!.request("terminal.input", {
    id: terminal.id,
    data: "'" + gh.replaceAll("'", "'\"'\"'") + "' auth login\r",
  });
}
async function exportWorkspace(key: string, session: Session) {
  const files = [],
    directories = [];
  for await (const entry of workspaceEntries(session.filesystem)) {
    if (entry.kind === "directory") directories.push(entry.path);
    else {
      const doc = session.documents.get(entry.path);
      const snapshot = doc
        ? { text: doc.text.toString(), encoding: doc.encoding, eol: doc.eol }
        : await session.filesystem.read(entry.path);
      files.push({ path: entry.path, ...snapshot });
    }
  }
  await native.archive(key, JSON.stringify({ version: 1, files, directories }));
}
async function importWorkspace(key: string, session: Session) {
  const contents = await native.archive(key);
  if (!contents) return;
  const archive = JSON.parse(contents);
  if (
    archive.version !== 1 ||
    !Array.isArray(archive.files) ||
    !Array.isArray(archive.directories ?? [])
  )
    throw new Error("Invalid workspace archive");
  if (
    (await session.workbench.ask(
      "Import workspace?",
      "Files in this archive may replace existing project files. Save your documents before importing.",
      ["Import", "Cancel"],
    )) !== "Import"
  )
    return;
  if ([...session.documents.documents.values()].some((doc) => doc.dirty))
    throw new Error("Save or close unsaved documents before importing");
  for (const directory of [...(archive.directories ?? [])].sort(
    (a: string, b: string) => a.length - b.length,
  ))
    await session.filesystem.mkdir(directory);
  for (const file of archive.files) {
    if (typeof file.path !== "string" || typeof file.text !== "string")
      throw new Error("Invalid archive file");
    let revision: string | null = null;
    try {
      revision = (await session.filesystem.read(file.path)).revision;
    } catch (error) {
      if (!/ENOENT|NOT_FOUND|not found/i.test(String(error))) throw error;
    }
    await session.filesystem.write(file.path, file.text, {
      expectedRevision: revision,
      encoding: file.encoding,
      eol: file.eol,
    });
  }
  await session.workbench.refreshFiles();
}
createRoot(document.getElementById("root")!).render(<App />);
