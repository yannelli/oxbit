import type {
  FileSystem,
  FileSnapshot,
  Kernel,
  Persistence,
  RpcClient,
} from "@zapp/sdk";
interface Layers {
  user: Record<string, unknown>;
  workspace: Record<string, unknown>;
  userLanguages: Record<string, Record<string, unknown>>;
  workspaceLanguages: Record<string, Record<string, unknown>>;
}
interface WorkspaceLayers {
  workspace: Layers["workspace"];
  workspaceLanguages: Layers["workspaceLanguages"];
}
interface PendingSettings {
  value: WorkspaceLayers;
  revision: string | null;
  lastText?: string;
}
const empty = (): WorkspaceLayers => ({
  workspace: {},
  workspaceLanguages: {},
});
function fromFile(text: string): WorkspaceLayers {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Workspace settings must contain a JSON object.");
  const result = empty();
  for (const [key, setting] of Object.entries(value)) {
    const language = key.match(/^\[([^\]]+)\]$/)?.[1];
    if (language) {
      if (!setting || typeof setting !== "object" || Array.isArray(setting))
        throw new Error(`Settings for ${language} must contain an object.`);
      result.workspaceLanguages[language] = setting as Record<string, unknown>;
    } else result.workspace[key] = setting;
  }
  return result;
}
function toFile(value: WorkspaceLayers) {
  const result: Record<string, unknown> = { ...value.workspace };
  for (const [language, settings] of Object.entries(value.workspaceLanguages))
    if (Object.keys(settings).length) result[`[${language}]`] = settings;
  return JSON.stringify(result, null, 2) + "\n";
}
export class ScopedConfigurationPersistence implements Persistence {
  private revision: string | null = null;
  private lastText?: string;
  private pending?: Layers;
  private queue: Promise<void> = Promise.resolve();
  private error?: string;
  private notify?: (message: string, type?: string) => void;
  private disposed = false;
  private initialized = false;
  private off?: () => void;
  private watch?: { dispose(): void };
  private kernel?: Kernel;
  private loaded?: Promise<Layers>;
  readonly key: string;
  constructor(
    private storage: Persistence,
    private filesystem: FileSystem,
    private runtime?: RpcClient,
  ) {
    this.key = "workspace-settings:" + filesystem.id;
  }
  async get<T>(key: string): Promise<T | undefined> {
    if (key !== "settings") return this.storage.get<T>(key);
    this.loaded ??= this.loadSettings();
    return this.loaded as Promise<T>;
  }
  private async loadSettings(): Promise<Layers> {
    const legacy = await this.storage.get<Layers>("settings");
    const profile = (await this.storage.get<
      Pick<Layers, "user" | "userLanguages">
    >("profile-settings")) || {
      user: legacy?.user || {},
      userLanguages: legacy?.userLanguages || {},
    };
    let workspace =
      (await this.storage.get<WorkspaceLayers>(this.key)) ||
      (this.filesystem.id === "browser"
        ? {
            workspace: legacy?.workspace || {},
            workspaceLanguages: legacy?.workspaceLanguages || {},
          }
        : empty());
    const pending = this.runtime
      ? await this.storage.get<PendingSettings>(this.key + ":pending")
      : undefined;
    if (pending) {
      workspace = pending.value;
      this.revision = pending.revision;
      this.lastText = pending.lastText;
      this.pending = { ...profile, ...workspace };
    }
    if (this.runtime) {
      try {
        const file = await this.runtime!.request<FileSnapshot>("fs.read", {
          path: ".zapp/settings.json",
        });
        if (!pending || toFile(workspace) === toFile(fromFile(file.text))) {
          workspace = fromFile(file.text);
          this.revision = file.revision;
          this.lastText = toFile(workspace);
          this.pending = undefined;
          await this.storage.delete(this.key + ":pending");
        } else if (file.revision !== this.revision) {
          this.report(
            "Workspace settings changed on disk. Local settings were recovered; resolve .zapp/settings.json before saving them.",
          );
        }
      } catch (e) {
        if (!/ENOENT|NOT_FOUND|not found|does not exist/i.test(String(e)))
          this.report(`Workspace settings could not be loaded: ${String(e)}`);
      }
    }
    if (
      this.lastText === undefined &&
      !Object.keys(workspace.workspace).length &&
      !Object.keys(workspace.workspaceLanguages).length
    )
      this.lastText = toFile(workspace);
    this.initialized = true;
    if (this.pending && this.runtime?.connected)
      this.queue = this.queue
        .then(() => this.flush())
        .catch((e) =>
          this.report(`Workspace settings were retained locally: ${String(e)}`),
        );
    return { ...profile, ...workspace };
  }
  async set(key: string, value: unknown) {
    if (key !== "settings") {
      await this.storage.set(key, value);
      return;
    }
    const layers = structuredClone(value) as Layers;
    await this.storage.set("profile-settings", {
      user: layers.user,
      userLanguages: layers.userLanguages,
    });
    await this.storage.set(this.key, {
      workspace: layers.workspace,
      workspaceLanguages: layers.workspaceLanguages,
    });
    if (this.runtime && this.initialized && toFile(layers) === this.lastText) {
      this.pending = undefined;
      await this.storage.delete(this.key + ":pending");
    } else if (this.runtime && this.initialized) {
      this.pending = layers;
      await this.storage.set(this.key + ":pending", {
        value: {
          workspace: layers.workspace,
          workspaceLanguages: layers.workspaceLanguages,
        },
        revision: this.revision,
        lastText: this.lastText,
      } satisfies PendingSettings);
      this.queue = this.queue
        .then(() => this.flush())
        .catch((e) =>
          this.report(`Workspace settings were retained locally: ${String(e)}`),
        );
      await this.queue;
    }
  }
  async delete(key: string) {
    if (key === "settings") {
      await this.storage.delete("profile-settings");
      await this.storage.delete(this.key);
      await this.storage.delete(this.key + ":pending");
    } else await this.storage.delete(key);
  }
  attach(kernel: Kernel, notify: (message: string, type?: string) => void) {
    this.kernel = kernel;
    this.notify = notify;
    if (this.error) {
      notify(this.error, "error");
      this.error = undefined;
    }
    if (this.runtime) {
      this.off = this.runtime.subscribe("connection.change", (event) => {
        if (event.state === "connected" && this.pending)
          this.queue = this.queue
            .then(() => this.flush())
            .catch((e) =>
              this.report(
                `Workspace settings were retained locally: ${String(e)}`,
              ),
            );
      });
      this.watch = this.filesystem.watch((event) => {
        if (
          event.path !== ".zapp/settings.json" ||
          this.pending ||
          this.disposed
        )
          return;
        void this.reload().catch((e) =>
          this.report(`Workspace settings reload failed: ${String(e)}`),
        );
      });
    }
  }
  private report(message: string) {
    if (this.notify) this.notify(message, "error");
    else this.error = message;
  }
  private async reload() {
    if (!this.kernel || this.disposed) return;
    let snapshot: FileSnapshot | undefined;
    try {
      snapshot = await this.runtime!.request<FileSnapshot>("fs.read", {
        path: ".zapp/settings.json",
      });
    } catch (error) {
      if (!/ENOENT|NOT_FOUND|not found|does not exist/i.test(String(error)))
        throw error;
    }
    if ((snapshot?.revision ?? null) === this.revision) return;
    const workspace = snapshot ? fromFile(snapshot.text) : empty();
    this.revision = snapshot?.revision ?? null;
    this.lastText = toFile(workspace);
    const current = this.kernel.configuration.export() as Layers;
    this.kernel.configuration.import({ ...current, ...workspace });
  }
  async resolveWorkspaceSettings(choice: "disk" | "local") {
    if (!this.runtime?.connected || !this.kernel)
      throw new Error("Connect to the runtime first");
    await this.queue;
    const current = this.kernel.configuration.export() as Layers;
    let snapshot: FileSnapshot | undefined;
    try {
      snapshot = await this.runtime.request<FileSnapshot>("fs.read", {
        path: ".zapp/settings.json",
      });
    } catch (error) {
      if (!/ENOENT|NOT_FOUND|not found|does not exist/i.test(String(error)))
        throw error;
    }
    this.revision = snapshot?.revision ?? null;
    this.lastText = toFile(snapshot ? fromFile(snapshot.text) : empty());
    this.pending = undefined;
    await this.storage.delete(this.key + ":pending");
    if (choice === "disk") {
      const workspace = snapshot ? fromFile(snapshot.text) : empty();
      await this.storage.set(this.key, workspace);
      this.kernel.configuration.import({ ...current, ...workspace });
    } else await this.set("settings", current);
  }
  private async flush() {
    if (!this.pending || this.disposed) return;
    if (!this.runtime?.connected)
      throw new Error(
        "Runtime is offline. Reconnect to save workspace settings.",
      );
    const value = this.pending;
    const text = toFile(value);
    if (text === this.lastText) {
      this.pending = undefined;
      await this.storage.delete(this.key + ":pending");
      return;
    }
    try {
      await this.runtime.request("fs.mkdir", { path: ".zapp" });
    } catch (e) {
      if (!/EEXIST|already exists/i.test(String(e))) throw e;
    }
    const snapshot = await this.runtime.request<FileSnapshot>("fs.write", {
      path: ".zapp/settings.json",
      text,
      expectedRevision: this.revision,
      encoding: "utf-8",
      eol: "LF",
    });
    this.revision = snapshot.revision;
    this.lastText = snapshot.text;
    if (this.pending === value) {
      this.pending = undefined;
      await this.storage.delete(this.key + ":pending");
    } else if (this.pending) {
      await this.storage.set(this.key + ":pending", {
        value: {
          workspace: this.pending.workspace,
          workspaceLanguages: this.pending.workspaceLanguages,
        },
        revision: this.revision,
        lastText: this.lastText,
      } satisfies PendingSettings);
    }
  }
  dispose() {
    this.disposed = true;
    this.off?.();
    this.watch?.dispose();
  }
}
