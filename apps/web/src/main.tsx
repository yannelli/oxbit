import { translate as tr, setLocale, installTextInputPolicy } from "@oxbit/ui";
import * as ReactHost from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserFileSystem,
  IndexedDBPersistence,
  pickDirectory,
  restoreDirectory,
} from "@oxbit/host-browser";
import { RuntimeClient, RuntimeFileSystem } from "@oxbit/host-runtime";
import {
  Workbench,
  workspaceEntries,
  themeMode,
  themeVariables,
  currentTheme,
} from "@oxbit/workbench";
import { OxbitLogo } from "@oxbit/ui";
import {
  type FileSystem,
  type FileSystemProvider,
} from "@oxbit/sdk";
import seed from "./seed.json";
import { WorkspaceDialog } from "./workspace-dialog";
import { createWorkbenchSession, type Session } from "@oxbit/app-workbench";
import { WebRuntimeConnector, describeFailure } from "./runtime-connector";
import "@oxbit/ui/tokens.css";
import "@oxbit/ui/workbench.css";
(globalThis as any).__OXBIT_REACT__ = ReactHost;
installTextInputPolicy(document);
const persistence = new IndexedDBPersistence();
let live: Session | undefined;
let bootQueue: Promise<void> = Promise.resolve();
const browserFilesystem = new BrowserFileSystem(persistence, "browser");
let installRuntimeSession: (session: Session) => void = () => {};
const connector = new WebRuntimeConnector({
  persistence,
  open: async runtime => installRuntimeSession(await boot(new RuntimeFileSystem(runtime), runtime)),
});
// The oxbit command opens a URL carrying the owner pairing code and the file to focus. Consume them once
// so a reload does not mint a second owner session, and so they stop trailing the address bar.
function takeLaunchParams() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const pair = params.get("pair") || undefined;
  const open = params.get("open") || undefined;
  if (pair || open)
    history.replaceState(null, "", location.pathname + location.search);
  return { pair, open };
}
async function openRuntime(url: string, pairingCode?: string, runtimeId?: string) {
  const existing = new RuntimeClient(url, "default", { runtimeId });
  try {
    // Sessions outlive a runtime restart, so reuse one before spending the code on a duplicate grant.
    // A restricted grant already held by this tab must not shadow an owner pairing code.
    await existing.connect();
    if (!pairingCode || existing.session?.owner) return existing;
  } catch (error) {
    if (!pairingCode) {
      existing.dispose();
      throw error;
    }
  }
  existing.dispose();
  const paired = new RuntimeClient(url);
  try {
    await paired.pair(pairingCode);
    await paired.connect();
    return paired;
  } catch (error) {
    paired.dispose();
    throw error;
  }
}
function boot(
  filesystem: FileSystem,
  runtime?: RuntimeClient,
): Promise<Session> {
  const next = bootQueue.then(() => openSession(filesystem, runtime));
  bootQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}
async function openSession(filesystem: FileSystem, runtime?: RuntimeClient): Promise<Session> {
  await live?.persist();
  const next = await createWorkbenchSession({ filesystem, runtime, persistence, preserveFilesystem: filesystem === browserFilesystem, runtimeConnector: connector });
  await live?.dispose();
  live = next;
  return next;
}

function App() {
  const [session, setSession] = useState<Session>(),
    [error, setError] = useState(""),
    [overlay, setOverlay] = useState<"workspace">(),
    [loading, setLoading] = useState(true);
  const installSession = useCallback((s: Session) => {
    connector.attach(s);
    setSession(s);
    setLoading(false);
    (globalThis as any).__oxbit = {
      ...s,
      ready: true,
      connectRuntime,
      useBrowserWorkspace,
      openFile: (path: string, options?: any) =>
        s.workbench.openFile(path, options),
      runCommand: (id: string, args?: unknown) => s.workbench.run(id, args),
    };
  }, []);
  const useBrowserWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      if (!(await browserFilesystem.list()).length)
        await browserFilesystem.import(seed);
      const s = await boot(browserFilesystem);
      await persistence.set("last-host", "browser");
      installSession(s);
      setOverlay(undefined);
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }, [installSession]);
  installRuntimeSession = (s: Session) => {
    installSession(s);
    setOverlay(undefined);
  };
  const connectRuntime = useCallback((url: string, code: string) => connector.pair(url, code), []);
  useEffect(() => {
    let stopped = false;
    const start = async () => {
      const { pair: pairingCode, open: launchPath } = takeLaunchParams();
      let saved = await persistence.get<any>("last-host");
      let runtime: RuntimeClient | undefined;
      let pairingError = "";
      let reconnectError = "";
      if (pairingCode || saved?.url)
        try {
          runtime = await openRuntime(
            pairingCode ? location.origin : saved.url,
            pairingCode,
            pairingCode ? undefined : saved.runtimeId,
          );
          if (pairingCode || runtime.identity?.id !== saved?.runtimeId) {
            saved = { url: runtime.url, runtimeId: runtime.identity?.id };
            await persistence.set("last-host", saved);
          }
        } catch (failure) {
          const url = pairingCode ? location.origin : saved.url;
          const message = await describeFailure(url, failure);
          if (pairingCode) pairingError = message;
          else reconnectError = message;
          connector.store.fail(message);
        }
      const directory =
        saved === "directory" ? await restoreDirectory(persistence) : undefined;
      const filesystem = runtime
        ? new RuntimeFileSystem(runtime)
        : (directory ?? browserFilesystem);
      if (
        filesystem === browserFilesystem &&
        !(await browserFilesystem.list()).length
      )
        await browserFilesystem.import(seed);
      let next = await boot(filesystem, runtime);
      if (pairingError || reconnectError)
        next.workbench.notify(
          pairingError
            ? tr("Runtime pairing failed: {0}", { 0: pairingError })
            : tr("Could not reconnect to the runtime: {0}", { 0: reconnectError }),
          "error",
          { actions: [{ title: tr("Open Runtime"), command: "runtime.open" }] },
        );
      if (saved === "directory" && !directory)
        next.workbench.notify(
          tr(
            "Directory access needs permission. Open the directory again; drafts remain stored.",
          ),
        );
      if (saved?.providerId) {
        const contribution = next.kernel.contributions
          .list("filesystem")
          .find((item) => item.id === saved.providerId);
        const provider = contribution?.data as FileSystemProvider | undefined;
        if (provider && typeof provider.open === "function") {
          try {
            next = await boot(await provider.open());
            next.workbench.set({ projectName: contribution!.title });
          } catch (failure) {
            next.workbench.notify(String(failure), "error");
          }
        } else
          next.workbench.notify(
            tr(
              "The saved filesystem provider is unavailable. Enable its extension to reopen the workspace.",
            ),
          );
      }
      if (launchPath)
        try {
          await next.workbench.openFile(launchPath, { preview: false });
        } catch (failure) {
          next.workbench.notify(
            tr("Could not open {0}: {1}", {
              0: launchPath,
              1: String(failure),
            }),
            "error",
          );
        }
      if (!stopped) installSession(next);
    };
    void start().catch((e) => {
      setError(String(e));
      setLoading(false);
    });
    return () => {
      stopped = true;
    };
  }, [installSession]);
  useEffect(() => {
    if (!session) return;
    const add = (id: string, title: string, run: () => unknown) =>
      session.kernel.commands.register({
        id,
        title,
        category: "Workspace",
        run,
      });
    const regs = [
      add("workspace.open", "Open Folder…", () => setOverlay("workspace")),
      add("workspace.switch", "Switch Workspace…", () =>
        setOverlay("workspace"),
      ),
      add("workspace.close", "Close Workspace", () => {
        session.kernel.context.set("workspace", false);
        session.workbench.set({ workspaceOpen: false });
        session.kernel.events.emit("workspace.change", {
          id: session.filesystem.id,
          state: "closed",
        });
      }),
      add("workspace.browser", "Open Browser Workspace", useBrowserWorkspace),
      add("workspace.runtime", "Connect Runtime", () =>
        session.workbench.run("runtime.cloud"),
      ),
      add("workspace.export", "Export Browser Workspace", async () => {
        const files = [];
        const directories = [];
        for await (const entry of workspaceEntries(session.filesystem))
          if (entry.kind === "file") {
            const doc = session.documents.get(entry.path);
            const snap = doc
              ? {
                  text: doc.text.toString(),
                  encoding: doc.encoding,
                  eol: doc.eol,
                }
              : await session.filesystem.read(entry.path);
            files.push({ path: entry.path, ...snap });
          } else directories.push(entry.path);
        const blob = new Blob(
          [JSON.stringify({ version: 1, files, directories }, null, 2)],
          {
            type: "application/json",
          },
        );
        const url = URL.createObjectURL(blob),
          a = document.createElement("a");
        a.href = url;
        a.download = "oxbit-workspace.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    ];
    session.workbench.touch();
    return () => regs.forEach((d) => d.dispose());
  }, [session, useBrowserWorkspace]);
  if (!session)
    return (
      <div className="workbench" data-theme="dark" data-density="compact">
        <div className="empty-state" style={{ height: "100%" }}>
          <OxbitLogo />
          <strong>
            {loading
              ? tr("Opening workspace…")
              : tr("Workspace failed to open")}
          </strong>
          {error && <p role="alert">{error}</p>}
          {error && (
            <button
              className="button"
              onClick={() => void useBrowserWorkspace()}
            >
              {tr("Retry")}
            </button>
          )}
        </div>
      </div>
    );
  return (
    <SessionView
      session={session}
      overlay={overlay}
      close={() => setOverlay(undefined)}
      useBrowserWorkspace={useBrowserWorkspace}
      onConnect={() => void session.workbench.run("runtime.cloud")}
      onOpenWorkspace={() => setOverlay("workspace")}
      openProvider={async (id) => {
        const contribution = session.kernel.contributions
          .list("filesystem")
          .find((item) => item.id === id);
        const provider = contribution?.data as FileSystemProvider | undefined;
        try {
          if (!provider || typeof provider.open !== "function")
            throw new Error("Filesystem provider is unavailable");
          const next = await boot(await provider.open());
          next.workbench.set({ projectName: contribution!.title });
          await persistence.set("last-host", { providerId: id });
          installSession(next);
          setOverlay(undefined);
        } catch (failure) {
          session.workbench.notify(String(failure), "error");
        }
      }}
      openDirectory={async () => {
        try {
          const fs = await pickDirectory(persistence);
          const s = await boot(fs);
          await persistence.set(
            "last-host",
            fs.id.startsWith("directory:") ? "directory" : "browser",
          );
          installSession(s);
          setOverlay(undefined);
        } catch (e) {
          session.workbench.notify(String(e), "error");
        }
      }}
      importWorkspace={async (file: File) => {
        try {
          const archive = JSON.parse(await file.text());
          await browserFilesystem.import(archive);
          await useBrowserWorkspace();
        } catch (e) {
          session.workbench.notify(String(e), "error");
        }
      }}
    />
  );
}
function SessionView({
  session,
  overlay,
  close,
  useBrowserWorkspace,
  onConnect,
  onOpenWorkspace,
  openDirectory,
  openProvider,
  importWorkspace,
}: {
  session: Session;
  overlay?: "workspace";
  close: () => void;
  useBrowserWorkspace: () => Promise<void>;
  onConnect: () => void;
  onOpenWorkspace: () => void;
  openDirectory: () => Promise<void>;
  openProvider: (id: string) => Promise<void>;
  importWorkspace: (file: File) => Promise<void>;
}) {
  useSyncExternalStore(session.workbench.subscribe, session.workbench.snapshot);
  setLocale(session.kernel.configuration.get<string>("workbench.locale"));
  const theme = themeMode(session.kernel);
  return (
    <>
      <Workbench
        workbench={session.workbench}
        runtime={session.runtime}
        onConnect={onConnect}
        onOpenWorkspace={onOpenWorkspace}
      />
      {overlay && (
        <div
          className="runtime-connect"
          data-theme={theme}
          data-theme-pack={currentTheme(session.kernel).packId}
          data-density="compact"
          style={{
            ...themeVariables(session.kernel),
            color: "var(--fg)",
            fontFamily: "var(--font-body-font-family)",
            fontSize: "var(--font-body-font-size)",
          }}
        >
          <WorkspaceDialog
            session={session}
            close={close}
            useBrowserWorkspace={useBrowserWorkspace}
            openDirectory={openDirectory}
            onConnect={() => { close(); void session.workbench.run("runtime.open"); }}
            openProvider={openProvider}
            importWorkspace={importWorkspace}
          />
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
