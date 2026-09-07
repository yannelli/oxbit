import { translate as tr, setLocale } from "@zapp/ui";
import * as ReactHost from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createKernel } from "@zapp/core";
import { DocumentService } from "@zapp/documents";
import {
  BrowserFileSystem,
  IndexedDBPersistence,
  pickDirectory,
  restoreDirectory,
} from "@zapp/host-browser";
import { RuntimeClient, RuntimeFileSystem } from "@zapp/host-runtime";
import {
  Workbench,
  WorkbenchController,
  createWorkbenchFeature,
} from "@zapp/workbench";
import { Dialog, Icon } from "@zapp/ui";
import {
  languageIdForPath,
  type FileSystem,
  type FileSystemProvider,
  type Kernel,
} from "@zapp/sdk";
import { createFeature as editorFeature } from "@zapp/feature-editor";
import { createFeature as explorerFeature } from "@zapp/feature-explorer";
import { createFeature as settingsFeature } from "@zapp/feature-settings";
import { createFeature as extensionsFeature } from "@zapp/feature-extensions";
import { createFeature as themesFeature } from "@zapp/feature-themes";
import { createFeature as languageFeature } from "@zapp/feature-language";
import { createFeature as searchFeature } from "@zapp/feature-search";
import { createFeature as previewsFeature } from "@zapp/feature-previews";
import {
  createFeature as formattersFeature,
  createPrettierFeature,
  createTypeScriptFormatterFeature,
} from "@zapp/feature-formatters";
import { createFeature as terminalFeature } from "@zapp/feature-terminal";
import { createFeature as tasksFeature } from "@zapp/feature-tasks";
import { createFeature as gitFeature } from "@zapp/feature-git";
import { createFeature as collaborationFeature } from "@zapp/feature-collaboration";
import bundleInspector from "@zapp/bundle-inspector";
import seed from "./seed.json";
import { ScopedConfigurationPersistence } from "./configuration.js";
import "@zapp/ui/tokens.css";
import "@zapp/ui/workbench.css";
(globalThis as any).__ZAPP_REACT__ = ReactHost;
interface Session {
  kernel: Kernel;
  documents: DocumentService;
  workbench: WorkbenchController;
  filesystem: FileSystem;
  runtime?: RuntimeClient;
  dispose(): Promise<void>;
}
const persistence = new IndexedDBPersistence();
let live: Session | undefined;
let bootQueue: Promise<void> = Promise.resolve();
const browserFilesystem = new BrowserFileSystem(persistence, "browser");
// The runtime prints its URL with the owner pairing code in the fragment. Consume the code once so a
// reload does not mint a second owner session, and so it stops trailing the address bar.
function takePairingCode() {
  const code = new URLSearchParams(location.hash.replace(/^#/, "")).get("pair");
  if (code) history.replaceState(null, "", location.pathname + location.search);
  return code || undefined;
}
async function openRuntime(url: string, pairingCode?: string) {
  const existing = new RuntimeClient(url);
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
async function openSession(
  filesystem: FileSystem,
  runtime?: RuntimeClient,
): Promise<Session> {
  const previous = live;
  if (previous) {
    await previous.documents.persist();
    await previous.workbench.persist();
  }
  const previousAPI = (globalThis as any).__zapp;
  (globalThis as any).__zapp = { ready: false };
  const configurationPersistence = new ScopedConfigurationPersistence(
    persistence,
    filesystem,
    runtime,
  );
  await configurationPersistence.get("settings");
  const kernel = createKernel({
    environment: "browser",
    persistence: configurationPersistence,
  });
  const documents = new DocumentService(filesystem, persistence, kernel);
  const workbench = new WorkbenchController(
    kernel,
    documents,
    filesystem,
    persistence,
  );
  configurationPersistence.attach(kernel, (message, type) =>
    workbench.notify(message, type),
  );
  if (runtime) {
    kernel.commands.register({
      id: "settings.reloadWorkspace",
      title: "Reload Workspace Settings from Disk",
      run: async () => {
        if (
          (await workbench.ask(
            tr("Reload workspace settings?"),
            tr("Replace local workspace settings with the disk file?"),
            [tr("Reload"), tr("Cancel")],
          )) === tr("Reload")
        )
          await configurationPersistence.resolveWorkspaceSettings("disk");
      },
    });
    kernel.commands.register({
      id: "settings.saveWorkspace",
      title: "Save Workspace Settings to Disk",
      run: async () => {
        if (
          (await workbench.ask(
            tr("Save workspace settings?"),
            tr("Replace the disk settings file with local workspace settings?"),
            [tr("Save"), tr("Cancel")],
          )) === tr("Save")
        )
          await configurationPersistence.resolveWorkspaceSettings("local");
      },
    });
  }
  kernel.services.register("workbench", workbench);
  kernel.services.register("documents", documents);
  kernel.services.register("filesystem", filesystem);
  kernel.services.register("persistence", persistence);
  if (runtime) kernel.services.register("runtime", runtime);
  kernel.context.set("workspace", true);
  kernel.context.set("connected", !!runtime?.connected);
  kernel.context.set("editor", false);
  try {
    await documents.restore();
    const options = { kernel, documents, filesystem, runtime, workbench };
    const connection = runtime?.subscribe("connection.change", ({ state }) => {
      kernel.context.set("connected", state === "connected");
      kernel.context.set(
        "trusted",
        state === "connected" && !!runtime.session?.trusted,
      );
      kernel.events.emit("connection.change", { state });
    });
    const features = [
      settingsFeature(options),
      themesFeature(options),
      createWorkbenchFeature(workbench),
      editorFeature(options),
      explorerFeature(options),
      extensionsFeature(options),
      formattersFeature(options),
      createPrettierFeature(),
      createTypeScriptFormatterFeature(),
      languageFeature(options),
      searchFeature(options),
      previewsFeature(options),
      terminalFeature(options),
      tasksFeature(options),
      gitFeature(options),
      collaborationFeature(options),
      bundleInspector,
    ];
    for (const feature of features) kernel.extensions.register(feature);
    const disabled =
      (await persistence.get<string[]>("extension-disabled")) || [];
    for (const feature of features)
      if (disabled.includes(feature.manifest.id))
        await kernel.extensions.disable(feature.manifest.id);
    for (const [savedId, url] of Object.entries(
      (await persistence.get<Record<string, string>>("extension-artifacts")) ||
        {},
    ))
      try {
        if (kernel.extensions.list().some((e) => e.manifest.id === savedId)) {
          const mod = await import(/* @vite-ignore */ url);
          await kernel.extensions.update(mod.default || mod.extension);
        } else await kernel.extensions.load(url, { activate: false });
        if (disabled.includes(savedId))
          await kernel.extensions.disable(savedId);
      } catch (error) {
        workbench.notify(
          `Extension recovery failed: ${String(error)}`,
          "error",
        );
      }
    await kernel.extensions.trigger("onStartup");
    await kernel.extensions.trigger("onWorkspace");
    for (const doc of documents.documents.values())
      await kernel.extensions.trigger(
        "onLanguage:" + languageIdForPath(doc.path),
      );
    for (const record of kernel.extensions.list())
      if (record.state === "failed")
        workbench.notify(`${record.manifest.name}: ${record.error}`, "error");
    const documentChange = documents.subscribe(workbench.documentChanged);
    await workbench.restore();
    const sampleWorkspace = filesystem.id === "browser";
    workbench.set({
      projectName: runtime
        ? (runtime.session?.workspaceName ?? "Runtime workspace")
        : sampleWorkspace
          ? "orbit-dash"
          : "Directory workspace",
    });
    if (!workbench.state.groups.some((g) => g.tabs.length)) {
      const paths = !sampleWorkspace
        ? ([
            workbench.state.files.find(
              (f) => f.kind === "file" && /\.(tsx?|jsx?|md)$/.test(f.path),
            )?.path,
          ].filter(Boolean) as string[])
        : [
            "src/hooks/useTelemetry.ts",
            "src/App.tsx",
            "src/components/Chart.tsx",
            "README.md",
          ];
      for (const path of paths)
        try {
          await workbench.openFile(path, { preview: false });
        } catch (error) {
          workbench.notify(String(error), "error");
        }
      if (sampleWorkspace) {
        workbench.set({
          groups: workbench.state.groups.map((g) => ({
            ...g,
            tabs: g.tabs.map((t) =>
              t.path === "src/App.tsx" ? { ...t, pinned: true } : t,
            ),
          })),
          panel: true,
          panelId: "terminal",
        });
        await workbench.openFile("src/hooks/useTelemetry.ts");
      }
    }
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const save = async (path: string) => {
      try {
        if (documents.get(path)?.dirty) await documents.save(path);
      } catch (error) {
        workbench.notify(String(error), "error");
      }
    };
    const change = kernel.events.on("document.change", ({ id }) => {
      const doc = [...documents.documents.values()].find((d) => d.id === id);
      if (!doc) return;
      clearTimeout(timers.get(doc.path));
      if (
        kernel.configuration.get(
          "files.autoSave",
          languageIdForPath(doc.path),
        ) === "afterDelay"
      ) {
        timers.set(
          doc.path,
          setTimeout(
            () => void save(doc.path),
            kernel.configuration.get<number>(
              "files.autoSaveDelay",
              languageIdForPath(doc.path),
            ) ?? 1000,
          ),
        );
      }
    });
    const configurationChange = kernel.configuration.subscribe(() => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const doc of documents.documents.values())
        if (
          doc.dirty &&
          kernel.configuration.get(
            "files.autoSave",
            languageIdForPath(doc.path),
          ) === "afterDelay"
        )
          timers.set(
            doc.path,
            setTimeout(
              () => void save(doc.path),
              kernel.configuration.get<number>(
                "files.autoSaveDelay",
                languageIdForPath(doc.path),
              ) ?? 1000,
            ),
          );
    });
    const focus = (e: FocusEvent) => {
      const editor = (e.target as HTMLElement)?.closest(".cm-editor");
      if (
        !editor ||
        (e.relatedTarget instanceof Node && editor.contains(e.relatedTarget))
      )
        return;
      for (const doc of documents.documents.values())
        if (
          kernel.configuration.get(
            "files.autoSave",
            languageIdForPath(doc.path),
          ) === "onFocusChange"
        )
          void save(doc.path);
    };
    const windowBlur = () => {
      for (const doc of documents.documents.values())
        if (
          kernel.configuration.get(
            "files.autoSave",
            languageIdForPath(doc.path),
          ) === "onWindowChange"
        )
          void save(doc.path);
    };
    const persist = () => {
      void documents.persist();
      void workbench.persist();
    };
    const protect = (e: BeforeUnloadEvent) => {
      persist();
      if ([...documents.documents.values()].some((d) => d.dirty)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("focusout", focus);
    window.addEventListener("blur", windowBlur);
    window.addEventListener("pagehide", persist);
    window.addEventListener("beforeunload", protect);
    const session: Session = {
      kernel,
      documents,
      filesystem,
      workbench,
      runtime,
      async dispose() {
        document.removeEventListener("focusout", focus);
        window.removeEventListener("blur", windowBlur);
        window.removeEventListener("pagehide", persist);
        window.removeEventListener("beforeunload", protect);
        for (const timer of timers.values()) clearTimeout(timer);
        change.dispose();
        configurationChange();
        connection?.();
        documentChange();
        await documents.persist();
        await workbench.persist();
        configurationPersistence.dispose();
        workbench.dispose();
        kernel.dispose();
        documents.dispose();
        runtime?.dispose();
        if (filesystem !== browserFilesystem) filesystem.dispose?.();
      },
    };
    await previous?.dispose();
    live = session;
    kernel.events.emit("workspace.change", {
      id: filesystem.id,
      state: "opened",
    });
    kernel.events.emit("connection.change", {
      state: runtime?.connected ? "connected" : "disconnected",
    });
    return session;
  } catch (error) {
    configurationPersistence.dispose();
    workbench.dispose();
    kernel.dispose();
    documents.dispose();
    runtime?.dispose();
    if (filesystem !== browserFilesystem && filesystem !== previous?.filesystem)
      filesystem.dispose?.();
    (globalThis as any).__zapp = previousAPI;
    throw error;
  }
}
function App() {
  const [session, setSession] = useState<Session>(),
    [error, setError] = useState(""),
    [overlay, setOverlay] = useState<"connection" | "workspace">(),
    [loading, setLoading] = useState(true);
  const installSession = useCallback((s: Session) => {
    setSession(s);
    setLoading(false);
    (globalThis as any).__zapp = {
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
  const connectRuntime = useCallback(
    async (url: string, code: string) => {
      setLoading(true);
      const runtime = new RuntimeClient(url);
      try {
        await runtime.pair(code);
        await runtime.connect();
        const s = await boot(new RuntimeFileSystem(runtime), runtime);
        await persistence.set("last-host", { url });
        installSession(s);
        setOverlay(undefined);
      } catch (e) {
        runtime.dispose();
        setLoading(false);
        throw e;
      }
    },
    [installSession],
  );
  useEffect(() => {
    let stopped = false;
    const start = async () => {
      const pairingCode = takePairingCode();
      let saved = await persistence.get<any>("last-host");
      let runtime: RuntimeClient | undefined;
      let pairingError = "";
      if (pairingCode || saved?.url)
        try {
          runtime = await openRuntime(
            pairingCode ? location.origin : saved.url,
            pairingCode,
          );
          if (pairingCode) {
            saved = { url: runtime.url };
            await persistence.set("last-host", saved);
          }
        } catch (failure) {
          if (pairingCode) pairingError = String(failure);
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
      if (pairingError)
        next.workbench.notify(
          tr("Runtime pairing failed: {0}", { 0: pairingError }),
          "error",
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
        setOverlay("connection"),
      ),
      add("workspace.export", "Export Browser Workspace", async () => {
        const files = [];
        const directories = [];
        for (const entry of session.workbench.state.files)
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
        a.download = "zapp-workspace.json";
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
          <div className="welcome-logo">Z</div>
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
      connectRuntime={connectRuntime}
      useBrowserWorkspace={useBrowserWorkspace}
      onConnect={() => setOverlay("connection")}
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
  connectRuntime,
  useBrowserWorkspace,
  onConnect,
  onOpenWorkspace,
  openDirectory,
  openProvider,
  importWorkspace,
}: {
  session: Session;
  overlay?: "connection" | "workspace";
  close: () => void;
  connectRuntime: (url: string, code: string) => Promise<void>;
  useBrowserWorkspace: () => Promise<void>;
  onConnect: () => void;
  onOpenWorkspace: () => void;
  openDirectory: () => Promise<void>;
  openProvider: (id: string) => Promise<void>;
  importWorkspace: (file: File) => Promise<void>;
}) {
  useSyncExternalStore(session.workbench.subscribe, session.workbench.snapshot);
  setLocale(session.kernel.configuration.get<string>("workbench.locale"));
  const theme = session.kernel.configuration
    .get<string>("workbench.colorTheme")
    ?.includes("light")
    ? "light"
    : "dark";
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
          data-density="compact"
          style={{
            color: "var(--fg)",
            fontFamily: "'Instrument Sans',sans-serif",
            fontSize: 13,
          }}
        >
          {overlay === "connection" ? (
            <ConnectionDialog
              runtime={session.runtime}
              close={close}
              connect={connectRuntime}
              workbench={session.workbench}
            />
          ) : (
            <Dialog title={tr("Open Workspace")} onClose={close}>
              <div className="workspace-options">
                <button
                  className="button"
                  onClick={() => void useBrowserWorkspace()}
                >
                  <Icon name="folder" />
                  {tr("Browser workspace")}
                  <span className="muted">{tr("Persisted in IndexedDB")}</span>
                </button>
                <button className="button" onClick={() => void openDirectory()}>
                  <Icon name="folderOpen" />
                  {tr("Open directory")}
                  <span className="muted">
                    {"showDirectoryPicker" in window
                      ? tr("Browser directory access")
                      : tr("Persisted fallback")}
                  </span>
                </button>
                <button className="button" onClick={onConnect}>
                  <Icon name="cloud" />
                  {tr("Runtime filesystem")}
                  <span className="muted">{tr("Pair with Node runtime")}</span>
                </button>
                {session.kernel.contributions
                  .list("filesystem")
                  .map((provider) => (
                    <button
                      key={provider.id}
                      className="button"
                      onClick={() => void openProvider(provider.id)}
                    >
                      <Icon name="folderOpen" />
                      {tr(provider.title)}
                    </button>
                  ))}
                <label className="button">
                  <Icon name="plus" />
                  {tr("Import workspace JSON")}
                  <input
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void importWorkspace(file);
                    }}
                  />
                </label>
                <button
                  className="button"
                  onClick={() => {
                    void session.workbench.run("workspace.export");
                    close();
                  }}
                >
                  <Icon name="save" />
                  {tr("Export workspace")}
                </button>
                <button
                  className="button"
                  onClick={() => {
                    void session.workbench.run("git.clone");
                    close();
                  }}
                >
                  <Icon name="git" />
                  {tr("Clone Repository…")}
                </button>
                <button
                  className="button"
                  onClick={() => {
                    void session.workbench.run("workspace.close");
                    close();
                  }}
                >
                  {tr("Close Workspace")}
                </button>
              </div>
            </Dialog>
          )}
        </div>
      )}
    </>
  );
}
function ConnectionDialog({
  runtime,
  close,
  connect,
  workbench,
}: {
  runtime?: RuntimeClient;
  close: () => void;
  connect: (url: string, code: string) => Promise<void>;
  workbench: WorkbenchController;
}) {
  const [url, setUrl] = useState(runtime?.url || location.origin),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [trusted, setTrusted] = useState(!!runtime?.session?.trusted);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await connect(url, code);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={tr("Runtime Connection")} onClose={close}>
      {runtime?.connected ? (
        <div className="runtime-form">
          <p>
            {tr("Connected to")} <strong>{runtime.url}</strong>.
          </p>
          <p>
            {tr("Workspace tool execution:")}{" "}
            <strong>{trusted ? tr("Trusted") : tr("Restricted")}</strong>
          </p>
          <p>
            {tr(
              "Trust allows terminals, tasks, Git hooks and language servers to execute workspace code.",
            )}
          </p>
          <button
            className="button primary"
            onClick={() =>
              void runtime
                .trust(!trusted)
                .then(() => {
                  setTrusted(!trusted);
                  if (runtime.session) runtime.session.trusted = !trusted;
                  workbench.kernel.context.set("trusted", !trusted);
                  workbench.touch();
                })
                .catch((e) => setError(String(e)))
            }
          >
            {trusted
              ? tr("Revoke workspace trust")
              : tr("Trust workspace tools")}
          </button>
          <button
            className="button"
            onClick={() => {
              runtime.disconnect();
              workbench.touch();
              close();
            }}
          >
            {tr("Disconnect")}
          </button>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <form className="runtime-form" onSubmit={(e) => void submit(e)}>
          <p>
            {tr("Start the Node runtime and enter its owner pairing code.")}
          </p>
          <label>
            {tr("Runtime URL")}
            <input
              type="url"
              required
              aria-label={tr("Runtime URL")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label>
            {tr("Pairing code")}
            <input
              required
              autoComplete="off"
              aria-label={tr("Pairing code")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="button" onClick={close}>
              {tr("Cancel")}
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? tr("Connecting…") : tr("Pair and connect")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
