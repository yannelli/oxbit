import * as ReactHost from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Session } from "@oxbit/app-workbench";
import { native, type RecentWorkspace } from "@oxbit/host-ios";
import { configurePanelWindows, currentTheme, themeMode, themeVariables, Workbench } from "@oxbit/workbench";
import { installTextInputPolicy, setLocale } from "@oxbit/ui";
import { StartScreen } from "./start-screen.js";
import { RuntimeConnection } from "./runtime-connection.js";
import { closeWorkspace, lastWorkspace, loadRecents, forgetRecent, openWorkspace, type OpenRequest, type OpenWorkspace } from "./workspaces.js";
import "@oxbit/ui/tokens.css";
import "@oxbit/ui/workbench.css";
import "./ios.css";

(globalThis as any).__OXBIT_REACT__ = ReactHost;
installTextInputPolicy(document);
// Panel tabs move with pointer events on touch; floating panel windows do not exist on iOS.
configurePanelWindows({ pointerDrag: true, detach: false, open: () => null });
window.open = ((url?: string | URL) => {
  if (url) void native.external(String(url));
  return null;
}) as typeof window.open;
document.addEventListener("click", (event) => {
  const anchor = (event.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (anchor && ["https:", "http:", "mailto:"].includes(anchor.protocol)) {
    event.preventDefault();
    void native.external(anchor.href);
  }
});

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [workspace, setWorkspace] = useState<OpenWorkspace>();
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [sheet, setSheet] = useState(true);
  const [connection, setConnection] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [restoring, setRestoring] = useState(true);
  const current = useRef<OpenWorkspace>(undefined);
  const opening = useRef(false);
  current.current = workspace;

  const open = useCallback(async (request: OpenRequest) => {
    if (opening.current) return "A workspace is already opening.";
    if (request.kind === "recent" && request.recent.id === current.current?.recent.id &&
      (request.recent.kind !== "runtime" || current.current.session.runtime?.connected)) {
      setSheet(false);
      return;
    }
    opening.current = true;
    setError(undefined);
    setBusy(request.kind === "pick" ? "Choose a folder…" : "Opening…");
    try {
      const previous = current.current;
      const next = await openWorkspace(request);
      if (previous) await closeWorkspace(previous);
      setWorkspace(next);
      setRecents(await loadRecents());
      setSheet(false);
    } catch (e) {
      const message = describe(e);
      if (!/cancelled/i.test(message)) setError(message);
      return message;
    } finally {
      opening.current = false;
      setBusy(undefined);
    }
  }, []);

  const close = useCallback(async () => {
    const previous = current.current;
    if (!previous) return;
    setWorkspace(undefined);
    setSheet(true);
    await closeWorkspace(previous).catch((e) => setError(describe(e)));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setRecents(await loadRecents());
        const last = await lastWorkspace();
        if (last) await open({ kind: "recent", recent: last });
      } catch (e) {
        setError(describe(e));
      } finally {
        setRestoring(false);
      }
    })();
  }, [open]);

  useEffect(() => {
    const persist = () => {
      if (document.visibilityState === "hidden") void current.current?.session.persist();
    };
    document.addEventListener("visibilitychange", persist);
    return () => document.removeEventListener("visibilitychange", persist);
  }, []);

  useEffect(() => {
    const session = workspace?.session;
    if (!session) return;
    const registrations = [
      ["workspace.open", "Open Folder…", () => open({ kind: "pick" })],
      ["workspace.switch", "Switch Workspace…", () => setSheet(true)],
      ["workspace.close", "Close Workspace", () => close()],
      ["workspace.runtime", "Connect Runtime", () => setConnection(true)],
    ] as const;
    const disposables = registrations.map(([id, title, run]) =>
      session.kernel.commands.register({ id, title, category: "Workspace", run: () => void run() }),
    );
    session.workbench.touch();
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [workspace?.session, open, close]);

  const start = (
    <StartScreen
      recents={recents}
      busy={busy ?? (restoring ? "Restoring your last workspace…" : undefined)}
      error={error}
      current={workspace?.recent.id}
      onOpenDocuments={() => void open({ kind: "documents" })}
      onPick={() => void open({ kind: "pick" })}
      onOpenRecent={(recent) => void open({ kind: "recent", recent })}
      onForget={(recent) => void forgetRecent(recent.id).then(setRecents, (e) => setError(describe(e)))}
      onDismiss={workspace ? () => setSheet(false) : undefined}
      onConnect={() => setConnection(true)}
    />
  );
  return (
    <Shell session={workspace?.session}>
      {workspace && (
        <ActiveWorkbench session={workspace.session} name={workspace.recent.name} onOpenWorkspace={() => setSheet(true)} onConnect={() => setConnection(true)} />
      )}
      {(sheet || !workspace) && <div className={workspace ? "ios-sheet" : "ios-fullscreen"}>{start}</div>}
      {connection && <RuntimeConnection session={workspace?.session} savedUrl={recents.find(recent => recent.kind === "runtime")?.url}
        connect={async (url, code) => {
          const error = await open({ kind: "runtime", url, code });
          if (error) throw new Error(error);
        }} disconnect={close} onClose={() => setConnection(false)} />}
    </Shell>
  );
}

function Shell({ session, children }: { session?: Session; children: React.ReactNode }) {
  useSyncExternalStore<unknown>(session?.workbench.subscribe ?? (() => () => {}), session?.workbench.snapshot ?? (() => 0));
  return (
    <div
      className="ios-shell"
      style={session ? themeVariables(session.kernel) : undefined}
      data-theme={session ? themeMode(session.kernel) : "dark"}
      data-theme-pack={session ? currentTheme(session.kernel).packId : undefined}
      data-density="compact"
    >
      {children}
    </div>
  );
}

function ActiveWorkbench({ session, name, onOpenWorkspace, onConnect }: { session: Session; name: string; onOpenWorkspace: () => void; onConnect: () => void }) {
  useSyncExternalStore(session.workbench.subscribe, session.workbench.snapshot);
  setLocale(session.kernel.configuration.get<string>("workbench.locale"));
  return (
    <Workbench
      workbench={session.workbench}
      runtime={session.runtime}
      onConnect={onConnect}
      onOpenWorkspace={onOpenWorkspace}
      workspaceControl={
        <button className="workspace-title" onClick={onOpenWorkspace}>
          {name}
        </button>
      }
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
