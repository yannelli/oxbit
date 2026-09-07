import { translate as tr } from "@zapp/ui";
import type { ComponentType } from "react";
import type { EditorView } from "@codemirror/view";
import type { DocumentService } from "@zapp/documents";
import { documentViewFor } from "./contributions.js";
import type {
  FileEntry,
  FileChange,
  FileSystem,
  Kernel,
  Persistence,
  OpenViewOptions,
  NotifyOptions,
} from "@zapp/sdk";
export interface OpenOptions {
  line?: number;
  col?: number;
  from?: number;
  to?: number;
  preview?: boolean;
  groupId?: string;
}
export interface Tab {
  id: string;
  title: string;
  path?: string;
  preview?: boolean;
  pinned?: boolean;
  component?: ComponentType<any>;
  props?: Record<string, unknown>;
  contributionId?: string;
  error?: string;
}
export interface Group {
  id: string;
  tabs: Tab[];
  active?: string;
  size?: number;
}
export interface Notification {
  id: string;
  message: string;
  type: string;
  time: number;
  ttl?: number;
  actions?: NotifyOptions["actions"];
  source?: string;
}
export interface WorkbenchState {
  groups: Group[];
  activeGroup: string;
  sidebar: boolean;
  sidebarId: string;
  sidebarWidth: number;
  panel: boolean;
  panelId: string;
  panelHeight: number;
  maxPanel: boolean;
  direction: "row" | "column";
  focus: boolean;
  files: FileEntry[];
  selectedPath?: string;
  expanded: string[];
  palette?: { mode: string; query: string };
  notifications: Notification[];
  notificationCenter: boolean;
  menu?: {
    name: string;
    x?: number;
    y?: number;
    ids?: string[];
    location?: string;
  };
  workspaceOpen: boolean;
  projectName: string;
  revision: number;
  recent: string[];
  keybindings: Record<string, string>;
  chord?: string;
  dialog?: {
    title: string;
    message?: string;
    value?: string;
    input?: boolean;
    danger?: boolean;
    choices: string[];
    resolve: (value: string | undefined, input?: string) => void;
  };
}
const initial = (): WorkbenchState => ({
  groups: [{ id: "g1", tabs: [] }],
  activeGroup: "g1",
  sidebar: (globalThis.innerWidth || 1440) >= 1100,
  sidebarId: "explorer",
  sidebarWidth: 260,
  panel: false,
  panelId: "terminal",
  panelHeight: 220,
  maxPanel: false,
  direction: "row",
  focus: false,
  files: [],
  expanded: [],
  notifications: [],
  notificationCenter: false,
  workspaceOpen: true,
  projectName: "Workspace",
  revision: 0,
  recent: [],
  keybindings: {},
});
export class WorkbenchController {
  state = initial();
  listeners = new Set<() => void>();
  editors = new Map<string, EditorView>();
  persistenceTimer?: ReturnType<typeof setTimeout>;
  disposed = false;
  private documentMetadata = "";
  private contributionTabs = new Set<string>();
  private refreshGeneration = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private directories = new Map<string, FileEntry[]>();
  constructor(
    readonly kernel: Kernel,
    readonly documents: DocumentService,
    readonly filesystem: FileSystem,
    readonly persistence: Persistence,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  set(patch: Partial<WorkbenchState>) {
    const expansionChanged =
      patch.expanded !== undefined &&
      patch.expanded.join("\0") !== this.state.expanded.join("\0");
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    if (expansionChanged && !this.disposed) {
      for (const directory of this.directories.keys())
        if (!this.directoryVisible(directory))
          this.directories.delete(directory);
      ++this.refreshGeneration;
      this.queueFilesRefresh();
    }
    if (
      patch.groups ||
      patch.activeGroup ||
      patch.selectedPath ||
      patch.workspaceOpen !== undefined
    )
      this.updateContext();
    for (const fn of this.listeners) fn();
    clearTimeout(this.persistenceTimer);
    this.persistenceTimer = setTimeout(() => void this.persist(), 250);
  }
  touch = () => this.set({});
  documentChanged = () => {
    const metadata = JSON.stringify(
      [...this.documents.documents.values()].map((doc) => [
        doc.id,
        doc.path,
        doc.dirty,
        doc.state,
        doc.readonly,
        doc.error,
        doc.encoding,
        doc.eol,
      ]),
    );
    if (metadata !== this.documentMetadata) {
      this.documentMetadata = metadata;
      this.touch();
    }
  };
  updateContext() {
    const tab = this.activeTab();
    const hasEditor = !!tab?.path && !tab.component && !tab.error;
    this.kernel.context.set("workspace", this.state.workspaceOpen);
    this.kernel.context.set("editor", hasEditor);
    this.kernel.context.set("activeTab", !!tab);
    this.kernel.context.set("split", this.state.groups.length > 1);
    this.kernel.context.set("explorer", !!this.state.selectedPath);
    this.kernel.context.set("markdown", !!tab?.path?.endsWith(".md"));
    this.kernel.context.set(
      "formattable",
      hasEditor && /\.(tsx?|jsx?|json|css|html|md)$/.test(tab!.path!),
    );
  }
  activateTab(groupId: string, tabId: string) {
    const tab = this.state.groups
      .find((group) => group.id === groupId)
      ?.tabs.find((tab) => tab.id === tabId);
    if (!tab) return;
    this.set({
      activeGroup: groupId,
      groups: this.state.groups.map((group) =>
        group.id === groupId ? { ...group, active: tabId } : group,
      ),
      ...(tab.path ? { selectedPath: tab.path } : {}),
    });
    const doc = tab.path ? this.documents.get(tab.path) : undefined;
    if (doc)
      this.kernel.events.emit("editor.active", { id: doc.id, viewId: groupId });
  }
  synchronizeContributions = () => {
    const contributions = this.kernel.contributions.list();
    const available = new Map(
      contributions.map((contribution) => [contribution.id, contribution]),
    );
    let changed = false;
    const closedViews: string[] = [];
    let groups: Group[] = this.state.groups.map((group) => {
      const tabs = group.tabs
        .filter((tab) => {
          if (!tab.contributionId || available.has(tab.contributionId))
            return true;
          changed = true;
          closedViews.push(tab.title);
          return false;
        })
        .map((tab) => {
          const contribution = tab.contributionId
            ? available.get(tab.contributionId)
            : undefined;
          if (
            contribution?.component &&
            tab.component !== contribution.component
          ) {
            changed = true;
            return { ...tab, component: contribution.component };
          }
          return tab;
        });
      return {
        ...group,
        tabs,
        active: tabs.some((tab) => tab.id === group.active)
          ? group.active
          : tabs.at(-1)?.id,
      };
    });
    groups = this.normalizeGroups(groups);
    const panels = contributions.filter((item) => item.kind === "panel");
    const views = contributions.filter((item) => item.kind === "activityView");
    if (
      changed ||
      !panels.some((panel) => panel.id === this.state.panelId) ||
      !views.some((view) => view.id === this.state.sidebarId)
    )
      this.set({
        groups,
        activeGroup: groups.some((group) => group.id === this.state.activeGroup)
          ? this.state.activeGroup
          : groups[0]!.id,
        panelId: panels.some((panel) => panel.id === this.state.panelId)
          ? this.state.panelId
          : panels[0]?.id || "",
        sidebarId: views.some((view) => view.id === this.state.sidebarId)
          ? this.state.sidebarId
          : views[0]?.id || "",
      });
    for (const contribution of contributions.filter(
      (item) => item.kind === "tab" && item.component,
    )) {
      if (this.contributionTabs.has(contribution.id)) continue;
      this.contributionTabs.add(contribution.id);
      if (
        (contribution.data as { openOnActivation?: boolean } | undefined)
          ?.openOnActivation
      )
        this.openView(
          contribution.id,
          contribution.title,
          contribution.component!,
          {},
          { contributionId: contribution.id },
        );
    }
    for (const id of this.contributionTabs)
      if (!available.has(id)) this.contributionTabs.delete(id);
    if (closedViews.length)
      this.notify(
        tr("Closed extension views: {0}", {
          0: [...new Set(closedViews)].join(", "),
        }),
      );
    this.touch();
  };
  private normalizeGroups(groups: Group[]): Group[] {
    const nonempty = groups.filter((group) => group.tabs.length);
    return nonempty.length
      ? nonempty
      : [{ id: groups[0]?.id || "g1", tabs: [] }];
  }
  async persist() {
    const {
      groups,
      activeGroup,
      sidebar,
      sidebarId,
      sidebarWidth,
      panel,
      panelId,
      panelHeight,
      direction,
      expanded,
      recent,
      keybindings,
    } = this.state;
    await this.persistence.set(`layout:${this.filesystem.id}`, {
      groups: groups.map((g) => ({
        ...g,
        tabs: g.tabs
          .filter((t) => t.path || t.contributionId)
          .map(({ component: _c, props, ...t }) => ({
            ...t,
            ...(props
              ? {
                  props: Object.fromEntries(
                    Object.entries(props).filter(
                      ([, value]) =>
                        ["string", "number", "boolean"].includes(
                          typeof value,
                        ) || value === null,
                    ),
                  ),
                }
              : {}),
          })),
      })),
      activeGroup,
      sidebar,
      sidebarId,
      sidebarWidth,
      panel,
      panelId,
      panelHeight,
      direction,
      expanded,
      recent,
      keybindings,
    });
  }
  async restore() {
    const saved = await this.persistence.get<Partial<WorkbenchState>>(
      `layout:${this.filesystem.id}`,
    );
    if (saved?.groups?.length) {
      const surfaces = new Set(
        [
          saved.panelId,
          saved.sidebarId,
          ...saved.groups.flatMap((group) =>
            group.tabs.map((tab) => tab.contributionId),
          ),
        ].filter((id): id is string => !!id),
      );
      for (const id of surfaces)
        await this.kernel.extensions.trigger("onView:" + id);
      for (const group of saved.groups)
        for (const tab of group.tabs)
          if (tab.path)
            try {
              await this.documents.open(tab.path);
            } catch {}
      const groups = saved.groups.map((group) => ({
        ...group,
        tabs: group.tabs
          .map((tab) => {
            const contribution = tab.contributionId
              ? this.kernel.contributions
                  .list()
                  .find((item) => item.id === tab.contributionId)
              : undefined;
            return {
              ...tab,
              ...(contribution?.component
                ? { component: contribution.component }
                : {}),
              ...(tab.path && !this.documents.get(tab.path)
                ? { error: "File is unavailable. Retry to load it." }
                : {}),
            };
          })
          .filter(
            (tab) =>
              !tab.contributionId ||
              this.kernel.contributions
                .list()
                .some((item) => item.id === tab.contributionId),
          ),
      }));
      const normalized = this.normalizeGroups(groups).map((group) => ({
        ...group,
        active: group.tabs.some((tab) => tab.id === group.active)
          ? group.active
          : group.tabs[0]?.id,
      }));
      this.set({
        ...saved,
        groups: normalized,
        activeGroup: normalized.some((group) => group.id === saved.activeGroup)
          ? saved.activeGroup
          : normalized[0]!.id,
        sidebar:
          (globalThis.innerWidth || 1440) >= 1100 ? !!saved.sidebar : false,
      });
    }
    await this.refreshFiles();
  }
  private directoryVisible(path: string) {
    return (
      !path ||
      path
        .split("/")
        .every((_, index, parts) =>
          this.state.expanded.includes(parts.slice(0, index + 1).join("/")),
        )
    );
  }
  private queueFilesRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refreshFiles(false), 80);
  }
  scheduleRefreshFiles = (change?: FileChange) => {
    if (this.disposed) return;
    if (change) {
      const parent = change.path.split("/").slice(0, -1).join("/");
      if (!this.directoryVisible(parent)) return;
      this.directories.delete(parent);
      for (const directory of this.directories.keys())
        if (
          directory === change.path ||
          directory.startsWith(change.path + "/")
        )
          this.directories.delete(directory);
    } else this.directories.clear();
    ++this.refreshGeneration;
    this.queueFilesRefresh();
  };
  async refreshFiles(invalidate = true) {
    clearTimeout(this.refreshTimer);
    if (this.disposed) return;
    if (invalidate) this.directories.clear();
    const generation = ++this.refreshGeneration;
    const all: FileEntry[] = [];
    const pending = [""];
    while (pending.length) {
      if (generation !== this.refreshGeneration || this.disposed) return;
      const directory = pending.pop()!;
      try {
        const entries =
          this.directories.get(directory) ??
          (await this.filesystem.list(directory));
        if (generation !== this.refreshGeneration || this.disposed) return;
        this.directories.set(directory, entries);
        for (const entry of entries) {
          all.push(entry);
          if (entry.kind === "directory" && this.directoryVisible(entry.path))
            pending.push(entry.path);
        }
      } catch (error) {
        if (generation !== this.refreshGeneration || this.disposed) return;
        this.notify(
          `${directory || this.state.projectName}: ${String(error)}`,
          "error",
        );
      }
    }
    if (generation === this.refreshGeneration && !this.disposed)
      this.set({ files: all });
  }
  revealFile(path: string) {
    const parents = path
      .split("/")
      .slice(0, -1)
      .map((_, index, parts) => parts.slice(0, index + 1).join("/"));
    this.set({
      selectedPath: path,
      expanded: [...new Set([...this.state.expanded, ...parents])],
    });
  }
  activeTab() {
    const g = this.state.groups.find((g) => g.id === this.state.activeGroup);
    return g?.tabs.find((t) => t.id === g.active);
  }
  activePath = () => this.activeTab()?.path;
  activeEditor = () =>
    this.activeTab()?.component
      ? undefined
      : this.editors.get(this.state.activeGroup);
  editorForPath = (path: string) => {
    for (const group of this.state.groups) {
      const tab = group.tabs.find((tab) => tab.id === group.active);
      if (tab?.path === path && !tab.component) {
        const editor = this.editors.get(group.id);
        if (editor) return editor;
      }
    }
    return undefined;
  };
  async openFile(path: string, options: OpenOptions = {}) {
    const start = performance.now();
    let failure: string | undefined;
    try {
      await this.documents.open(path);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (this.disposed) return;
    this.revealFile(path);
    const gid = options.groupId || this.state.activeGroup;
    if (!this.state.groups.some((group) => group.id === gid))
      throw new Error("Editor group does not exist");
    const custom = !failure ? documentViewFor(this.kernel, path) : undefined;
    if (custom?.component) {
      this.openView(
        path,
        path.split("/").pop() || path,
        custom.component,
        { path },
        { groupId: gid, path, contributionId: custom.id },
      );
      return;
    }
    const previousPreviews =
      this.state.groups
        .find((group) => group.id === gid)
        ?.tabs.filter(
          (tab) =>
            tab.preview &&
            tab.path &&
            tab.path !== path &&
            !this.documents.get(tab.path)?.dirty,
        )
        .map((tab) => tab.path!) || [];
    const groups = this.state.groups.map((g) => {
      if (g.id !== gid) return g;
      const exists = g.tabs.find((t) => t.path === path && !t.component);
      let tabs = g.tabs;
      if (!exists) {
        if (options.preview)
          tabs = tabs.filter(
            (t) =>
              !t.preview || (!!t.path && this.documents.get(t.path)?.dirty),
          );
        tabs = [
          ...tabs,
          {
            id: path,
            path,
            title: path.split("/").pop() || path,
            preview: options.preview,
            error: failure,
          },
        ];
      } else
        tabs = tabs.map((t) =>
          t.id === exists.id
            ? {
                ...t,
                error: failure,
                ...(options.preview === false ? { preview: false } : {}),
              }
            : t,
        );
      return { ...g, tabs, active: path };
    });
    this.set({
      groups,
      activeGroup: gid,
      selectedPath: path,
      workspaceOpen: true,
      recent: [path, ...this.state.recent.filter((p) => p !== path)].slice(
        0,
        40,
      ),
      ...((globalThis.innerWidth || 1440) < 1100 ? { sidebar: false } : {}),
    });
    for (const preview of previousPreviews)
      if (
        !this.state.groups.some((group) =>
          group.tabs.some((tab) => tab.path === preview),
        )
      )
        await this.documents.close(preview);
    const document = this.documents.get(path);
    if (document)
      this.kernel.events.emit("editor.active", {
        id: document.id,
        viewId: gid,
      });
    if (failure) return;
    requestAnimationFrame(() => {
      const view = this.editors.get(gid);
      if (view && (options.line !== undefined || options.from !== undefined)) {
        const line = view.state.doc.line(
          Math.max(1, Math.min(options.line || 1, view.state.doc.lines)),
        );
        const from = Math.max(
          0,
          Math.min(
            options.from ??
              Math.min(line.to, line.from + (options.col || 1) - 1),
            view.state.doc.length,
          ),
        );
        view.dispatch({
          selection: {
            anchor: from,
            head: Math.max(
              0,
              Math.min(options.to ?? from, view.state.doc.length),
            ),
          },
          scrollIntoView: true,
        });
      }
      view?.focus();
      performance.measure("zapp.file-switch", {
        start,
        end: performance.now(),
      });
    });
  }
  openView(
    id: string,
    title: string,
    component: ComponentType<any>,
    props: Record<string, unknown> = {},
    options: OpenViewOptions = {},
  ) {
    const gid = options.groupId || this.state.activeGroup;
    const contribution = this.kernel.contributions
      .list()
      .find(
        (item) =>
          item.id === options.contributionId || item.component === component,
      );
    if (!this.state.groups.some((group) => group.id === gid))
      throw new Error("Editor group does not exist");
    this.set({
      activeGroup: gid,
      groups: this.state.groups.map((g) =>
        g.id === gid
          ? {
              ...g,
              tabs: [
                ...g.tabs.filter((t) => t.id !== id),
                {
                  id,
                  title,
                  component,
                  props,
                  path: options.path,
                  contributionId: contribution?.id,
                },
              ],
              active: id,
            }
          : g,
      ),
    });
  }
  openPanel(id: string) {
    if (this.kernel.contributions.list("activityView").some((c) => c.id === id))
      this.openSidebar(id);
    else {
      this.set({ panel: true, panelId: id });
      void this.kernel.extensions
        .trigger("onView:" + id)
        .then(() => {
          if (this.disposed || !this.state.panel || this.state.panelId !== id)
            return;
          if (
            this.kernel.contributions
              .list("activityView")
              .some((c) => c.id === id)
          )
            this.set({ panel: false, sidebar: true, sidebarId: id });
        })
        .catch((error) => this.notify(String(error), "error"));
    }
  }
  togglePanel(id: string) {
    if (this.state.panel && this.state.panelId === id)
      this.set({ panel: false });
    else this.openPanel(id);
  }
  openSidebar(id: string) {
    this.set({ sidebar: true, sidebarId: id });
    void this.kernel.extensions
      .trigger("onView:" + id)
      .catch((error) => this.notify(String(error), "error"));
  }
  closeView(id: string) {
    const groups = this.normalizeGroups(
      this.state.groups.map((group) => {
        const tabs = group.tabs.filter((tab) => tab.id !== id);
        return {
          ...group,
          tabs,
          active: tabs.some((tab) => tab.id === group.active)
            ? group.active
            : tabs.at(-1)?.id,
        };
      }),
    );
    this.set({
      groups,
      activeGroup: groups.some((group) => group.id === this.state.activeGroup)
        ? this.state.activeGroup
        : groups[0]!.id,
    });
  }
  showContextMenu(
    location: string,
    x: number,
    y: number,
    commands: string[] = [],
  ) {
    this.set({ menu: { name: "context", location, x, y, ids: commands } });
  }
  openPalette(mode = "commands") {
    this.set({
      palette: {
        mode,
        query:
          mode === "commands"
            ? ">"
            : mode === "symbols"
              ? "@"
              : mode === "line"
                ? ":"
                : "",
      },
      menu: undefined,
    });
  }
  notify(message: string, type = "info", options: NotifyOptions = {}) {
    if (message === "Cancelled") return;
    const id = crypto.randomUUID();
    this.set({
      notifications: [
        ...this.state.notifications,
        {
          id,
          message,
          type,
          time: Date.now(),
          ttl: options.ttl === undefined ? 6500 : Math.max(0, options.ttl),
          actions: options.actions?.slice(0, 3),
          source: options.source,
        },
      ].slice(-100),
    });
  }
  async ask(
    title: string,
    message: string,
    choices = ["OK", "Cancel"],
    danger = false,
  ): Promise<string | undefined> {
    return new Promise((resolve) =>
      this.set({ dialog: { title, message, choices, danger, resolve } }),
    );
  }
  async prompt(title: string, value = ""): Promise<string | undefined> {
    return new Promise((resolve) =>
      this.set({
        dialog: {
          title,
          input: true,
          value,
          choices: ["Save", "Cancel"],
          resolve: (choice, input) =>
            resolve(choice === "Save" ? input : undefined),
        },
      }),
    );
  }
  finishDialog(choice?: string, value?: string) {
    const dialog = this.state.dialog;
    this.set({ dialog: undefined });
    dialog?.resolve(choice, value);
  }
  async run(id: string, args?: unknown) {
    if (this.state.menu) this.set({ menu: undefined });
    try {
      await this.kernel.commands.execute(id, args);
    } catch (e) {
      this.notify(e instanceof Error ? e.message : String(e), "error");
    }
  }
  async closeTab(gid: string, id: string) {
    const group = this.state.groups.find((g) => g.id === gid);
    const tab = group?.tabs.find((t) => t.id === id);
    const doc = tab?.path ? this.documents.get(tab.path) : undefined;
    const lastView =
      tab?.path &&
      !this.state.groups.some((g) =>
        g.tabs.some(
          (t) => !(g.id === gid && t.id === id) && t.path === tab.path,
        ),
      );
    if (doc?.dirty && lastView) {
      const result = await this.ask(
        tr("Save changes to {0}?", { "0": tab?.title }),
        tr("Your changes have not been saved."),
        ["Save", "Don't Save", "Cancel"],
      );
      if (!result || result === "Cancel") return;
      if (result === "Save") {
        try {
          await this.documents.save(doc.path);
        } catch (e) {
          this.notify(String(e), "error");
          return;
        }
      } else doc.replace(doc.savedText);
    }
    let groups = this.state.groups.map((g) => {
      if (g.id !== gid) return g;
      const tabs = g.tabs.filter((t) => t.id !== id);
      return {
        ...g,
        tabs,
        active: g.active === id ? tabs.at(-1)?.id : g.active,
      };
    });
    groups = this.normalizeGroups(groups);
    this.set({
      groups,
      activeGroup:
        groups.find((g) => g.id === this.state.activeGroup)?.id ||
        groups[0]?.id ||
        "g1",
    });
    if (lastView && tab?.path) await this.documents.close(tab.path);
  }
  split(direction: "row" | "column") {
    if (this.state.groups.length >= 3) {
      this.notify("Up to three editor groups are supported.");
      return;
    }
    const tab = this.activeTab();
    const id = crypto.randomUUID();
    this.set({
      groups: [
        ...this.state.groups,
        { id, tabs: tab ? [{ ...tab, pinned: false }] : [], active: tab?.id },
      ],
      activeGroup: id,
      direction,
    });
    this.kernel.context.set("split", true);
    return id;
  }
  moveTab(from: string, id: string, to: string) {
    if (from === to || !this.state.groups.some((group) => group.id === to))
      return;
    const tab = this.state.groups
      .find((g) => g.id === from)
      ?.tabs.find((t) => t.id === id);
    if (!tab) return;
    let groups = this.state.groups.map((g) => {
      if (g.id === from) {
        const tabs = g.tabs.filter((t) => t.id !== id);
        return { ...g, tabs, active: tabs.at(-1)?.id };
      }
      if (g.id === to)
        return {
          ...g,
          tabs: [...g.tabs.filter((t) => t.id !== id), tab],
          active: id,
        };
      return g;
    });
    groups = groups.filter((g) => g.tabs.length);
    this.set({ groups, activeGroup: to });
  }
  pin(groupId = this.state.activeGroup, tabId = this.activeTab()?.id) {
    const tab = this.state.groups
      .find((group) => group.id === groupId)
      ?.tabs.find((tab) => tab.id === tabId);
    if (tab)
      this.set({
        groups: this.state.groups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                tabs: g.tabs.map((t) =>
                  t.id === tab.id
                    ? { ...t, pinned: !t.pinned, preview: false }
                    : t,
                ),
              }
            : g,
        ),
      });
  }
  keepOpen() {
    const tab = this.activeTab();
    if (tab?.preview)
      this.set({
        groups: this.state.groups.map((g) => ({
          ...g,
          tabs: g.tabs.map((t) =>
            t.id === tab.id ? { ...t, preview: false } : t,
          ),
        })),
      });
  }
  resetLayout() {
    const tabs = this.state.groups
      .flatMap((g) => g.tabs)
      .filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i);
    this.set({
      ...initial(),
      files: this.state.files,
      projectName: this.state.projectName,
      recent: this.state.recent,
      keybindings: this.state.keybindings,
      workspaceOpen: this.state.workspaceOpen,
      groups: [{ id: "g1", tabs, active: tabs[0]?.id }],
    });
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.persistenceTimer);
    clearTimeout(this.refreshTimer);
    void this.persist();
    this.listeners.clear();
  }
}
