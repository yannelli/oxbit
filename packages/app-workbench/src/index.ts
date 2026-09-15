import { BrowserPackStore, IconThemeService, type PackStore } from "@oxbit/icon-themes";
import { translate as tr } from "@oxbit/ui";
import { createKernel } from "@oxbit/core";
import { DocumentService } from "@oxbit/documents";
import { RuntimeClient } from "@oxbit/host-runtime";
import { WorkbenchController, createWorkbenchFeature } from "@oxbit/workbench";
import {
  languageForKernel,
  type FileSystem,
  type Kernel,
  type Persistence,
} from "@oxbit/sdk";
import { createFeature as editorFeature } from "@oxbit/feature-editor";
import { createFeature as explorerFeature } from "@oxbit/feature-explorer";
import { createFeature as settingsFeature } from "@oxbit/feature-settings";
import { createFeature as extensionsFeature } from "@oxbit/feature-extensions";
import {
  createFeature as themesFeature,
  createVSCodeFeature,
  createVSCodeHighContrastFeature,
  createClassicOS98Feature,
  classicOS98IconPack,
  rainbowIconPack,
} from "@oxbit/feature-themes";
import { createFeature as keymapsFeature } from "@oxbit/feature-keymaps";
import { createFeature as languageFeature } from "@oxbit/feature-language";
import { createFeature as searchFeature } from "@oxbit/feature-search";
import { createFeature as previewsFeature } from "@oxbit/feature-previews";
import { createFeature as imagesFeature } from "@oxbit/feature-images";
import {
  createFeature as formattersFeature,
  createPrettierFeature,
  createTypeScriptFormatterFeature,
} from "@oxbit/feature-formatters";
import { createFeature as terminalFeature } from "@oxbit/feature-terminal";
import { createFeature as tasksFeature } from "@oxbit/feature-tasks";
import { createFeature as gitFeature } from "@oxbit/feature-git";
import { createFeature as collaborationFeature } from "@oxbit/feature-collaboration";
import { createFeature as agentACPFeature } from "@oxbit/feature-agent-acp";
import bundleInspector from "@oxbit/bundle-inspector";
import { ScopedConfigurationPersistence } from "./configuration.js";
export { ScopedConfigurationPersistence } from "./configuration.js";
export { RuntimeClient, RuntimeFileSystem } from "@oxbit/host-runtime";
const SEED_KEY = "oxbit.iconPack.seeded";
/** Origin-wide, matching the icon pack store, so every project shares one answer. */
const seedMarker = () => (typeof localStorage === "undefined" ? undefined : localStorage);

/** Installs each bundled pack once. Uninstalling is remembered until its revision changes. */
async function seedIconPack(store: PackStore) {
  for (const pack of [classicOS98IconPack, rainbowIconPack]) {
    try {
      const marker = seedMarker();
      // Keep the original ClassicOS marker for existing installations.
      const key = pack.id === classicOS98IconPack.id ? SEED_KEY : `${SEED_KEY}.${pack.id}`;
      if (marker?.getItem(key) === pack.revision) continue;
      const installed = (await store.read()).find(item => item.id === pack.id);
      if (installed?.revision !== pack.revision) await store.put(pack);
      marker?.setItem(key, pack.revision);
    } catch {
      // Icon packs stay optional; the workbench keeps its own glyphs.
    }
  }
}
export interface Session {
  kernel: Kernel;
  documents: DocumentService;
  workbench: WorkbenchController;
  filesystem: FileSystem;
  runtime?: RuntimeClient;
  setActive(active: boolean): void;
  persist(): Promise<void>;
  dispose(): Promise<void>;
}
export async function createWorkbenchSession({
  filesystem,
  runtime,
  persistence,
  active = true,
  protectUnload = true,
  preserveFilesystem = false,
  additionalExtensionOrigins,
  iconPackStore,
}: {
  filesystem: FileSystem;
  runtime?: RuntimeClient;
  persistence: Persistence;
  active?: boolean;
  protectUnload?: boolean;
  preserveFilesystem?: boolean;
  additionalExtensionOrigins?: readonly string[];
  iconPackStore?: PackStore;
}): Promise<Session> {
  const configurationPersistence = new ScopedConfigurationPersistence(
    persistence,
    filesystem,
    runtime,
  );
  await configurationPersistence.get("settings");
  const kernel = createKernel({
    environment: "browser",
    persistence: configurationPersistence,
    additionalExtensionOrigins,
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
      title: "Reload Settings from Disk",
      run: async () => {
        if (
          (await workbench.ask(
            tr("Reload settings?"),
            tr("Discard pending user and workspace changes and reload the merged settings files?"),
            [tr("Reload"), tr("Cancel")],
          )) === tr("Reload")
        )
          await configurationPersistence.resolveWorkspaceSettings("disk");
      },
    });
    kernel.commands.register({
      id: "settings.saveWorkspace",
      title: "Save Local Settings to Disk",
      run: async () => {
        if (
          (await workbench.ask(
            tr("Save local settings?"),
            tr("Apply pending user and workspace changes over the current disk settings?"),
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
  kernel.context.set("trusted", !!runtime?.session?.trusted);
  kernel.context.set("editor", false);
  const packStore = iconPackStore ?? new BrowserPackStore();
  const iconThemes = new IconThemeService(kernel, packStore, message => workbench.notify(message, "warning", { source: "Icon Packs", actions: [{ title: "Manage Icon Packs", command: "iconPacks.manage" }] }));
  kernel.services.register("iconThemes", iconThemes);
  try {
    await seedIconPack(packStore);
    await iconThemes.initialize().catch(error => workbench.notify(`Icon packs could not be loaded: ${String(error)}`, "warning"));
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
    const trust = runtime?.subscribe("workspace.trust", ({ trusted }) => {
      kernel.context.set("trusted", trusted === true);
      workbench.touch();
    });
    const features = [
      settingsFeature(options),
      themesFeature(options),
      createVSCodeFeature(options),
      createVSCodeHighContrastFeature(options),
      createClassicOS98Feature(options),
      keymapsFeature(options),
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
      imagesFeature(options),
      terminalFeature(options),
      tasksFeature(options),
      gitFeature(options),
      collaborationFeature(options),
      agentACPFeature(options),
      bundleInspector,
    ];
    for (const feature of features) kernel.extensions.register(feature);
    const disabled =
      (await persistence.get<string[]>("extension-disabled")) || [];
    const enabled = (await persistence.get<string[]>("extension-enabled")) || [];
    for (const feature of features)
      if (disabled.includes(feature.manifest.id) ||
          (feature.manifest.enabledByDefault === false && !enabled.includes(feature.manifest.id)))
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
        "onLanguage:" + languageForKernel(kernel, doc.path).id,
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
          languageForKernel(kernel, doc.path).id,
        ) === "afterDelay"
      ) {
        timers.set(
          doc.path,
          setTimeout(
            () => void save(doc.path),
            kernel.configuration.get<number>(
              "files.autoSaveDelay",
              languageForKernel(kernel, doc.path).id,
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
            languageForKernel(kernel, doc.path).id,
          ) === "afterDelay"
        )
          timers.set(
            doc.path,
            setTimeout(
              () => void save(doc.path),
              kernel.configuration.get<number>(
                "files.autoSaveDelay",
                languageForKernel(kernel, doc.path).id,
              ) ?? 1000,
            ),
          );
    });
    const focus = (e: FocusEvent) => {
      if (!active) return;
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
            languageForKernel(kernel, doc.path).id,
          ) === "onFocusChange"
        )
          void save(doc.path);
    };
    const windowBlur = () => {
      if (!active) return;
      for (const doc of documents.documents.values())
        if (
          kernel.configuration.get(
            "files.autoSave",
            languageForKernel(kernel, doc.path).id,
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
      if (
        protectUnload &&
        [...documents.documents.values()].some((d) => d.dirty)
      ) {
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
      setActive(value) {
        active = value;
      },
      async persist() {
        await kernel.configuration.flush?.();
        await configurationPersistence.set(
          "settings",
          kernel.configuration.export(),
        );
        await documents.persist();
        await workbench.persist();
      },
      async dispose() {
        document.removeEventListener("focusout", focus);
        window.removeEventListener("blur", windowBlur);
        window.removeEventListener("pagehide", persist);
        window.removeEventListener("beforeunload", protect);
        for (const timer of timers.values()) clearTimeout(timer);
        change.dispose();
        configurationChange();
        connection?.();
        trust?.();
        documentChange();
        await session.persist();
        iconThemes.dispose();
        await configurationPersistence.dispose();
        workbench.dispose();
        kernel.dispose();
        documents.dispose();
        runtime?.dispose();
        if (!preserveFilesystem) filesystem.dispose?.();
      },
    };
    kernel.events.emit("workspace.change", {
      id: filesystem.id,
      state: "opened",
    });
    kernel.events.emit("connection.change", {
      state: runtime?.connected ? "connected" : "disconnected",
    });
    return session;
  } catch (error) {
    iconThemes.dispose();
    await configurationPersistence.dispose();
    workbench.dispose();
    kernel.dispose();
    documents.dispose();
    runtime?.dispose();
    if (!preserveFilesystem) filesystem.dispose?.();
    throw error;
  }
}
