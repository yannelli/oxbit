import { desktopConfiguration } from "./configuration.js";
import { DesktopIconPackStore } from "./icon-packs.js";
import {
  profileChanges,
  type Profile,
  type SettingChange,
} from "./settings.js";
export {
  profileChanges,
  type Profile,
  type SettingChange,
} from "./settings.js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Persistence } from "@oxbit/sdk";
import { createWorkbenchSession, type Session } from "@oxbit/app-workbench";
import { RuntimeClient, RuntimeFileSystem } from "@oxbit/host-runtime";

export interface Project {
  key: string;
  path: string;
  name: string;
  owner: string;
  missing: boolean;
  openFile?: string;
  openFileId?: string;
}
export interface DesktopSnapshot {
  label: string;
  projects: Project[];
  active?: string;
  recent: string[];
  profile: Profile;
}
export interface Connection {
  openFile?: string;
  url: string;
  token: string;
  key: string;
}
export interface CloseRequest {
  id: string;
  keys: string[];
  reason: "project" | "window" | "quit" | "update";
}
export interface ToolStatus {
  name: string;
  path?: string;
  version?: string;
  authenticated?: boolean;
  guidance: string;
}
export interface UpdateStatus {
  status: "manual" | "unconfigured" | "available" | "current";
  version?: string;
  notes?: string;
  url?: string;
}
export const native = {
  snapshot: () => invoke<DesktopSnapshot>("desktop_snapshot"),
  open: (path?: string, newWindow = false, file = false) =>
    invoke<string | null>("desktop_open_project", { path, newWindow, file }),
  openRemote: (target: string, newWindow = false) =>
    invoke<string>("desktop_open_remote", { target, newWindow }),
  fileOpened: (key: string, request: string) =>
    invoke<void>("desktop_file_opened", { key, request }),
  activate: (key: string) => invoke<void>("desktop_activate", { key }),
  connection: (key: string, restart = false) =>
    invoke<Connection>("desktop_connection", { key, restart }),
  move: (key: string) => invoke<void>("desktop_move_project", { key }),
  close: (kind: CloseRequest["reason"], key?: string) =>
    invoke<void>("desktop_request_close", { kind, key }),
  closePanel: (id: string) => invoke<void>("desktop_close_panel", { id }),
  vote: (id: string, accepted: boolean) =>
    invoke<void>("desktop_close_vote", { id, accepted }),
  finished: (id: string, error?: string) =>
    invoke<void>("desktop_close_finished", { id, error }),
  settings: (changes: SettingChange[]) =>
    invoke<Profile>("desktop_settings_patch", { changes }),
  tools: (checkAuth = false) =>
    invoke<ToolStatus[]>("desktop_tools", { checkAuth }),
  external: (url: string) => invoke<void>("desktop_open_external", { url }),
  reveal: (key: string, relative = "") =>
    invoke<void>("desktop_reveal", { key, relative }),
  clipboard: (text?: string) => invoke<string>("desktop_clipboard", { text }),
  archive: (key: string, contents?: string) =>
    invoke<string | null>("desktop_archive", { key, contents }),
  checkUpdate: () => invoke<UpdateStatus>("desktop_check_update"),
  downloadUpdate: () => invoke<void>("desktop_download_update"),
};

export class DesktopPersistence implements Persistence {
  private profile: Profile = { user: {}, userLanguages: {} };
  private queue = Promise.resolve();
  constructor(readonly project: string) {}
  async get<T>(key: string): Promise<T | undefined> {
    const value = await invoke<T | null>("desktop_storage_get", {
      project: this.project,
      key,
    });
    if (key === "profile-settings" && value)
      this.profile = structuredClone(value as unknown as Profile);
    return value ?? undefined;
  }
  set(key: string, value: unknown): Promise<void> {
    const operation = async () => {
      if (key === "profile-settings") {
        const next = value as unknown as Profile;
        const changes = profileChanges(this.profile, next);
        const before = this.profile;
        this.profile = structuredClone(next);
        try { if (changes.length) await native.settings(changes); }
        catch (error) { this.profile = before; throw error; }
      } else
        await invoke("desktop_storage_set", {
          project: this.project,
          key,
          value,
        });
    };
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  delete(key: string): Promise<void> {
    if (key === "profile-settings")
      return this.set(key, { user: {}, userLanguages: {} });
    const next = this.queue.then(() =>
      invoke<void>("desktop_storage_set", {
        project: this.project,
        key,
        value: null,
      }),
    );
    this.queue = next.catch(() => {});
    return next;
  }
  flush() {
    return this.queue;
  }
  async refreshProfile(session: Session) {
    await session.kernel.configuration.flush?.();
    await this.flush();
    const before = structuredClone(this.profile);
    const latest = await this.get<Profile>("profile-settings");
    if (!latest) return;
    const current = session.kernel.configuration.export() as Profile &
      Record<string, unknown>;
    // Native menus still update the desktop profile. Apply only their changed keys
    // to the runtime configuration so the JSON persistence layer saves them too.
    const changes = profileChanges(before, latest);
    if (!changes.length) return;
    for (const change of changes) {
      let cursor = current as Record<string, any>;
      for (const key of change.path.slice(0, -1)) cursor = cursor[key] ??= {};
      const key = change.path.at(-1)!;
      if (change.value === undefined) delete cursor[key]; else cursor[key] = change.value;
    }
    session.kernel.configuration.import(current);
  }
}

export interface ProjectSession {
  project: Project;
  session?: Session;
  storage?: DesktopPersistence;
  error?: string;
  failed?: boolean;
  loading?: boolean;
}
export interface WindowView {
  projects: ProjectSession[];
  active?: string;
  recent: string[];
  profile: Profile;
  loading: boolean;
}

export class ProjectSessionManager {
  private entries = new Map<string, ProjectSession>();
  private listeners = new Set<() => void>();
  private queue = Promise.resolve();
  private subscriptions: UnlistenFn[] = [];
  private frozen = false;
  private view: WindowView = {
    projects: [],
    recent: [],
    profile: { user: {}, userLanguages: {} },
    loading: true,
  };
  snapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<WindowView> = {}) {
    this.view = { ...this.view, ...patch };
    for (const entry of this.entries.values()) {
      entry.session?.setActive(
        entry.project.key === this.view.active && !this.frozen,
      );
      entry.session?.workbench.panelWindows.setSuspended(this.frozen);
    }
    for (const listener of this.listeners) listener();
  }
  get isClosing() {
    return this.frozen;
  }
  get active() {
    return this.entries.get(this.view.active ?? "");
  }
  get(key: string) {
    return this.entries.get(key);
  }
  async start() {
    this.subscriptions.push(
      await listen("desktop-changed", () => void this.refresh()),
    );
    this.subscriptions.push(
      await listen<{ key: string }>("desktop-runtime-failed", ({ payload }) => {
        const entry = this.entries.get(payload.key);
        if (entry) {
          entry.failed = true;
          entry.error =
            entry.project.path.startsWith("ssh://")
              ? "The SSH connection closed. Your drafts are retained. Reconnect to resume editing and tools."
              : "The project runtime stopped. Your drafts are retained. Restart it to resume tools.";
          entry.session?.runtime?.terminated();
          void entry.session?.persist();
          this.publish();
        }
      }),
    );
    this.subscriptions.push(
      await listen("desktop-settings-changed", () => {
        for (const entry of this.entries.values())
          if (entry.session && entry.storage)
            void entry.storage
              .refreshProfile(entry.session)
              .catch((error) =>
                entry.session?.workbench.notify(String(error), "error"),
              );
        void native
          .snapshot()
          .then((snapshot) => this.publish({ profile: snapshot.profile }));
      }),
    );
    await this.refresh();
  }
  refresh() {
    const next = this.queue.then(async () => {
      const snapshot = await native.snapshot();
      if (this.frozen) return;
      for (const [key, entry] of this.entries)
        if (!snapshot.projects.some((project) => project.key === key)) {
          await entry.session?.dispose();
          await entry.storage?.flush();
          this.entries.delete(key);
        }
      this.publish({
        active: snapshot.active,
        recent: snapshot.recent,
        profile: snapshot.profile,
      });
      for (const project of snapshot.projects) {
        let entry = this.entries.get(project.key);
        if (!entry) {
          entry = { project };
          this.entries.set(project.key, entry);
        }
        entry.project = project;
        this.publish({ projects: snapshot.projects.map(p => this.entries.get(p.key)!).filter(Boolean) });
        if (!entry.session && !entry.error) await this.load(entry);
        if (project.openFile && entry.session) {
          try {
            await entry.session.workbench.openFile(project.openFile, {
              preview: false,
            });
            if (project.openFileId)
              await native.fileOpened(project.key, project.openFileId);
          } catch (error) {
            entry.session.workbench.notify(String(error), "error");
          }
        }
        this.publish({
          projects: snapshot.projects
            .map((p) => this.entries.get(p.key)!)
            .filter(Boolean),
        });
      }
      this.publish({
        projects: snapshot.projects
          .map((p) => this.entries.get(p.key)!)
          .filter(Boolean),
        loading: false,
      });
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private async load(entry: ProjectSession, restart = false) {
    entry.loading = true;
    entry.error = undefined;
    this.publish();
    try {
      if (entry.project.missing)
        throw new Error(
          "This folder is unavailable. Reconnect its disk, then retry. Drafts are retained.",
        );
      const connection = await native.connection(entry.project.key, restart);
      const runtime = new RuntimeClient(connection.url, "default", {
        token: connection.token,
        persistToken: false,
      });
      try {
        await runtime.connect();
        const storage = new DesktopPersistence(entry.project.key);
        const session = await createWorkbenchSession({
          filesystem: new RuntimeFileSystem(
            runtime,
            "desktop:" + entry.project.key,
          ),
          runtime,
          persistence: storage,
          iconPackStore: new DesktopIconPackStore(),
          additionalExtensionOrigins: ["tauri://localhost"],
          active: false,
          protectUnload: false,
        });
        session.workbench.set({ projectName: entry.project.name });
        for (const setting of desktopConfiguration) session.kernel.configuration.register(setting);
        const mirrorProfile = () => {
          const { user, userLanguages } = session.kernel.configuration.export() as Profile;
          void storage.set("profile-settings", { user, userLanguages }).catch(error => session.workbench.notify(String(error), "error"));
        };
        mirrorProfile();
        const offProfile = session.kernel.configuration.subscribe(mirrorProfile);
        const dispose = session.dispose.bind(session);
        session.dispose = async () => { offProfile(); await dispose(); };
        if (connection.openFile) await session.workbench.openFile(connection.openFile, { preview: false });
        entry.session = session;
        entry.storage = storage;
        entry.error = undefined;
        entry.failed = false;
      } catch (error) {
        runtime.dispose();
        throw error;
      }
    } catch (error) {
      entry.error = String(error);
    } finally {
      entry.loading = false;
      this.publish();
    }
  }
  async activate(key: string) {
    if (this.frozen) return;
    await native.activate(key);
    this.publish({ active: key });
  }
  async restart(key: string) {
    if (this.frozen) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    await entry.session?.persist();
    await entry.session?.dispose();
    await entry.storage?.flush();
    entry.session = undefined;
    entry.project.missing = false;
    await this.load(entry, true);
    this.publish();
  }
  async move(key: string) {
    if (this.frozen) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    await entry.session?.persist();
    await entry.session?.dispose();
    await entry.storage?.flush();
    entry.session = undefined;
    try {
      await native.move(key);
    } catch (error) {
      await this.load(entry);
      this.publish();
      throw error;
    }
    await this.refresh();
  }
  async prepare(request: CloseRequest) {
    await this.queue;
    this.frozen = true;
    this.publish();
    const dirty: string[] = [];
    let tools = 0;
    for (const key of request.keys) {
      const session = this.entries.get(key)?.session;
      if (!session) continue;
      for (const doc of session.documents.documents.values())
        if (doc.dirty)
          dirty.push(`${session.workbench.state.projectName}/${doc.path}`);
      if (session.runtime?.connected && session.runtime.session?.trusted) {
        const results = await Promise.all([
          session.runtime.request<{ exitCode?: number }[]>("terminal.list"),
          session.runtime.request<{ exitCode?: number }[]>("tasks.list"),
        ]);
        tools += results
          .flat()
          .filter((tool) => tool.exitCode === undefined).length;
      }
    }
    return { dirty, tools };
  }
  async saveAll(keys: string[]) {
    for (const key of keys) {
      const session = this.entries.get(key)?.session;
      if (!session) continue;
      for (const doc of session.documents.documents.values())
        if (doc.dirty) await session.documents.save(doc.path);
      await session.persist();
    }
  }
  async commitClose(keys: string[], discard: boolean) {
    // Persist every project before disposing any. A failed write leaves all sessions available.
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry?.session) continue;
      if (discard)
        for (const doc of entry.session.documents.documents.values())
          if (doc.dirty) doc.replace(doc.savedText);
      await entry.session.persist();
      await entry.storage?.flush();
    }
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry?.session) continue;
      await entry.session.dispose();
      await entry.storage?.flush();
      entry.session = undefined;
    }
  }
  cancelClose() {
    this.frozen = false;
    this.publish();
    void this.refresh();
  }
  async dispose() {
    for (const off of this.subscriptions) off();
    for (const entry of this.entries.values()) await entry.session?.dispose();
  }
}
