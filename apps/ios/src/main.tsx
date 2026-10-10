import * as ReactHost from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Session } from "@oxbit/app-workbench";
import { IosGitClient, installSpeechRecognition, native, ssh, type RecentWorkspace, type RemoteRuntimeEvent, type SshFileSystem } from "@oxbit/host-ios";
import { configurePanelWindows, currentTheme, themeMode, themeVariables, Workbench } from "@oxbit/workbench";
import { installTextInputPolicy, setLocale } from "@oxbit/ui";
import { StartScreen } from "./start-screen.js";
import { RuntimePage } from "@oxbit/feature-runtime";
import { runtimeConnector } from "./runtime-connector.js";
import { GitSettings } from "./git-settings.js";
import { CloneRepository } from "./clone-repository.js";
import { SshSettings } from "./ssh-settings.js";
import { SshConnect, type SshTarget } from "./ssh-connect.js";
import { SshTransfer, type TransferRequest } from "./ssh-transfer.js";
import { SshGitPrompt } from "./ssh-git-prompt.js";
import { DOCUMENTS_ID, closeWorkspace, lastWorkspace, loadRecents, forgetRecent, openWorkspace, type OpenRequest, type OpenWorkspace } from "./workspaces.js";
import "@oxbit/ui/tokens.css";
import "@oxbit/ui/workbench.css";
import "./ios.css";

(globalThis as any).__OXBIT_REACT__ = ReactHost;
installTextInputPolicy(document);
installSpeechRecognition();
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

type SshDialog = { preset?: SshTarget; mode?: "files" | "runtime"; browse?: boolean };

const RECONNECT = { title: "Reconnect", command: "ssh.runtime.reconnect" };

function sshTarget(recent?: RecentWorkspace, mode?: SshDialog["mode"]): SshDialog {
  return recent?.hostId ? { preset: { hostId: recent.hostId, path: recent.remotePath ?? "~" }, mode } : { mode };
}

/** The most recent folder per saved host, for the remote folder field. */
function lastFolders(recents: RecentWorkspace[]) {
  const folders: Record<string, string> = {};
  for (const recent of recents)
    if (recent.hostId && recent.remotePath && !(recent.hostId in folders)) folders[recent.hostId] = recent.remotePath;
  return folders;
}

/** Uploads land in the selected folder, or beside the selected file. */
function selectedDirectory(session: Session) {
  const path = session.workbench.state.selectedPath ?? "";
  const entry = session.workbench.state.files.find(file => file.path === path);
  return !path || entry?.kind === "directory" ? path : path.split("/").slice(0, -1).join("/");
}

function App() {
  const [workspace, setWorkspace] = useState<OpenWorkspace>();
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [sheet, setSheet] = useState(true);
  const [runtimePage, setRuntimePage] = useState(false);
  const [gitSettings, setGitSettings] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [sshSettings, setSshSettings] = useState(false);
  const [sshConnect, setSshConnect] = useState<SshDialog>();
  const [remoteProgress, setRemoteProgress] = useState<string>();
  const [transfer, setTransfer] = useState<TransferRequest>();
  const [gitPrompt, setGitPrompt] = useState<{ rootId: string; resolve: (retry: boolean) => void }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [restoring, setRestoring] = useState(true);
  const current = useRef<OpenWorkspace>(undefined);
  const opening = useRef(false);
  current.current = workspace;
  useEffect(() => {
    // One prompt at a time; a second request that needs one fails with its own error.
    IosGitClient.sshPrompt = rootId => new Promise<boolean>(resolve => setGitPrompt(active => {
      if (active) {
        resolve(false);
        return active;
      }
      return { rootId, resolve };
    }));
    return () => { IosGitClient.sshPrompt = undefined; };
  }, []);
  const finishGitPrompt = useCallback((retry: boolean) => setGitPrompt(active => {
    active?.resolve(retry);
    return undefined;
  }), []);

  const close = useCallback(async () => {
    const previous = current.current;
    if (!previous) return;
    flushSync(() => {
      setWorkspace(undefined);
      setSheet(true);
    });
    runtimeConnector.attach(undefined);
    await closeWorkspace(previous).catch((e) => setError(describe(e)));
  }, []);

  /** Progress while a remote runtime starts; afterwards, reconnects show as notifications. */
  const remoteEvent = useCallback((event: RemoteRuntimeEvent) => {
    if (opening.current) {
      if (event.state === "progress") setRemoteProgress(event.message);
      return;
    }
    const workbench = current.current?.session.workbench;
    if (!workbench) return;
    if (event.state === "failed" || event.state === "running")
      workbench.set({ notifications: workbench.state.notifications.filter(notice => !notice.actions?.some(action => action.command === RECONNECT.command)) });
    if (event.state === "failed") workbench.notify(event.message, "error", { ttl: 0, actions: [RECONNECT] });
    else if (event.state === "running") workbench.notify("Reconnected to the remote workspace.", "info");
    else workbench.notify(event.message, "info");
  }, []);

  /** A failure arrives as a `failed` event, whose notice offers Reconnect. */
  const resume = useCallback(() => {
    const active = current.current;
    if (active?.remote) void ssh.runtimeResume(active.remote.id).then(() => active.session.runtime?.reconnect()).catch(() => {});
  }, []);

  const open = useCallback(async (request: OpenRequest) => {
    if (opening.current) return "A workspace is already opening.";
    const active = current.current;
    if (request.kind === "sshRuntime" && active?.remote && active.recent.hostId === request.hostId) {
      if (active.recent.remotePath === request.path) {
        setSheet(false);
        return runtimeConnector.restart().then(() => undefined, describe);
      }
      // The new runtime cannot take the folder lock while the previous one holds it.
      await close();
    }
    if (request.kind === "documents" && current.current?.recent.kind === "documents" &&
      request.directory === current.current.recent.directory) {
      setSheet(false);
      return;
    }
    if (request.kind === "recent" && request.recent.id === current.current?.recent.id &&
      (request.recent.kind !== "runtime" || current.current.session.runtime?.connected)) {
      setSheet(false);
      return;
    }
    if (request.kind === "ssh" && current.current?.recent.kind === "ssh" && request.hostId === current.current.recent.hostId &&
      request.path === current.current.recent.remotePath) {
      setSheet(false);
      return;
    }
    opening.current = true;
    setError(undefined);
    setBusy(request.kind === "pick" ? "Choose a folder…" : "Opening…");
    setRemoteProgress(undefined);
    try {
      const previous = current.current;
      const next = await openWorkspace(request.kind === "sshRuntime" ? { ...request, onEvent: remoteEvent } : request);
      flushSync(() => {
        setWorkspace(next);
        setWorkspaceKey(key => key + 1);
        setSheet(false);
        setRuntimePage(false);
      });
      runtimeConnector.attach(next);
      if (previous) await closeWorkspace(previous);
      setRecents(await loadRecents());
    } catch (e) {
      const message = describe(e);
      if (!/cancelled/i.test(message)) setError(message);
      if (request.kind === "runtime" || request.kind === "sshRuntime" || (request.kind === "recent" && request.recent.kind === "runtime"))
        runtimeConnector.store.fail(message);
      return message;
    } finally {
      opening.current = false;
      setBusy(undefined);
    }
  }, [remoteEvent, close]);

  useEffect(() => { runtimeConnector.setRecents(recents); }, [recents]);
  useEffect(() => {
    runtimeConnector.host = {
      open, close,
      forget: id => forgetRecent(id).then(setRecents),
      startSsh: (hostId, path) => setSshConnect({ preset: { hostId, path }, mode: "runtime" }),
      manageSsh: () => setSshSettings(true),
    };
  }, [open, close]);
  useEffect(() => {
    void (async () => {
      try {
        await runtimeConnector.loadSettings();
        setRecents(await loadRecents());
        const last = await lastWorkspace();
        if (last?.kind === "ssh" || last?.kind === "sshRuntime") setSshConnect(sshTarget(last, last.kind === "sshRuntime" ? "runtime" : "files"));
        else if (last) await open({ kind: "recent", recent: last });
      } catch (e) {
        setError(describe(e));
      } finally {
        setRestoring(false);
      }
    })();
  }, [open]);

  useEffect(() => {
    // iOS suspends sockets in the background, so a remote runtime reconnects on return.
    const persist = () => {
      if (document.visibilityState === "hidden") void current.current?.session.persist();
      else {
        resume();
        const runtime = current.current?.session.runtime;
        if (runtime && !current.current?.remote && !runtime.connected && runtimeConnector.autoReconnect()) runtime.reconnect();
      }
    };
    document.addEventListener("visibilitychange", persist);
    return () => document.removeEventListener("visibilitychange", persist);
  }, [resume]);

  useEffect(() => {
    const session = workspace?.session;
    if (!session) return;
    const registrations = [
      ["workspace.open", "Open Folder…", () => open({ kind: "pick" })],
      ["workspace.switch", "Switch Workspace…", () => setSheet(true)],
      ["workspace.close", "Close Workspace", () => close()],
      ["workspace.runtime", "Runtime", () => session.workbench.run("runtime.cloud")],
      ["git.account", "Git Accounts and Commit Author", () => setGitSettings(true)],
      ["workspace.clone", "Clone Repository to Device", () => setCloning(true)],
    ] as const;
    const disposables = registrations.map(([id, title, run]) =>
      session.kernel.commands.register({ id, title, category: "Workspace", run: () => void run() }),
    );
    const filesystem = workspace.recent.kind === "ssh" ? session.filesystem as SshFileSystem : undefined;
    const sshCommands = [
      ["ssh.hosts", "SSH Hosts and Keys", () => setSshSettings(true)],
      ["ssh.connect", "Connect with SSH…", () => setSshConnect({})],
      ["ssh.runtime", "Start Oxbit on This Server…", () => setSshConnect({ mode: "runtime" })],
      ...workspace.remote ? [["ssh.runtime.reconnect", "Reconnect to Server", resume]] as const : [],
      ...workspace.recent.hostId ? [["ssh.folder.switch", "Switch Folder…", () => setSshConnect({
        ...sshTarget(workspace.recent, workspace.remote ? "runtime" : "files"), browse: true,
      })]] as const : [],
      ...filesystem ? [
        ["ssh.upload", "Upload Files Here…", () => setTransfer({ kind: "upload", filesystem, directory: selectedDirectory(session) })],
        ["ssh.download", "Download to Device…", () =>
          setTransfer({ kind: "download", filesystem, path: session.workbench.state.selectedPath ?? "" })],
      ] as const : [],
    ] as const;
    for (const [id, title, run] of sshCommands) {
      disposables.push(session.kernel.commands.register({ id, title, category: "SSH", run }));
      if (id === "ssh.upload" || id === "ssh.download")
        disposables.push(session.kernel.contributions.register({ id: `ios.${id}.explorer`, kind: "menu", location: "explorer", command: id, title }));
    }
    session.workbench.touch();
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [workspace?.session, workspace?.recent, workspace?.remote, open, close, resume]);

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
      onConnect={() => setRuntimePage(true)}
      onGitSettings={() => setGitSettings(true)}
      onClone={() => setCloning(true)}
      onSsh={recent => setSshConnect(sshTarget(recent))}
      onSshRuntime={recent => setSshConnect(sshTarget(recent, "runtime"))}
      onSshSettings={() => setSshSettings(true)}
    />
  );
  return (
    <Shell session={workspace?.session}>
      {workspace && (
        <ActiveWorkbench key={workspaceKey} session={workspace.session} name={workspace.recent.name} onOpenWorkspace={() => setSheet(true)}
          onConnect={() => void workspace.session.workbench.run("runtime.cloud")} />
      )}
      {(sheet || !workspace) && <div className={workspace ? "ios-sheet" : "ios-fullscreen"}>{start}</div>}
      {runtimePage && <div className="ios-sheet ios-runtime-sheet" role="dialog" aria-modal="true" aria-label="Runtime">
        <RuntimePage connector={runtimeConnector} settings={runtimeConnector.settings} onClose={() => setRuntimePage(false)} />
      </div>}
      {gitSettings && <GitSettings repository={workspace?.git} onClose={() => setGitSettings(false)} />}
      {cloning && <CloneRepository baseGit={workspace?.recent.id === DOCUMENTS_ID ? workspace.git : undefined}
        onOpen={directory => open({ kind: "documents", directory })} onClose={() => setCloning(false)} />}
      {sshConnect && <SshConnect preset={sshConnect.preset} mode={sshConnect.mode} browse={sshConnect.browse} progress={remoteProgress} lastFolders={lastFolders(recents)}
        onOpen={target => open({ kind: sshConnect.mode === "runtime" ? "sshRuntime" : "ssh", ...target })}
        onManage={() => { setSshConnect(undefined); setSshSettings(true); }} onClose={() => setSshConnect(undefined)} />}
      {sshSettings && <SshSettings onClose={() => setSshSettings(false)} />}
      {transfer && <SshTransfer request={transfer} onDone={() => { if (transfer.kind === "upload") void workspace?.session.workbench.refreshFiles(); }}
        onClose={() => setTransfer(undefined)} />}
      {gitPrompt && <SshGitPrompt rootId={gitPrompt.rootId} onDone={finishGitPrompt}
        onManage={() => { finishGitPrompt(false); setSshSettings(true); }} />}
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
