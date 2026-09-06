import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type {
  DocumentEdit,
  Encoding,
  Eol,
  FileChange,
  FileSnapshot,
  FileSystem,
  Kernel,
  Persistence,
  ResourceEdit,
  TextEdit,
} from "@zapp/sdk";

export const LOCAL_ORIGIN = Symbol("zapp.local");
export const DISK_ORIGIN = Symbol("zapp.disk");
export const REMOTE_ORIGIN = Symbol("zapp.remote");
export interface DocumentViewState {
  anchor: number;
  head: number;
  scrollTop: number;
  scrollLeft?: number;
  folds?: { from: number; to: number }[];
  selection?: { ranges: { anchor: number; head: number }[]; main: number };
}
interface Draft {
  id: string;
  path: string;
  update: Uint8Array;
  version: number;
  savedRevision: string;
  savedText: string;
  encoding: Encoding;
  eol: Eol;
  savedEncoding: Encoding;
  savedEol: Eol;
  views: [string, DocumentViewState][];
}
export class DocumentHandle {
  readonly ydoc = new Y.Doc();
  readonly text = this.ydoc.getText("content");
  readonly undo = new Y.UndoManager(this.text, {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 500,
  });
  readonly awareness = new Awareness(this.ydoc);
  readonly views = new Map<string, DocumentViewState>();
  version = 0;
  savedRevision: string;
  savedText: string;
  encoding: Encoding;
  eol: Eol;
  savedEncoding: Encoding;
  savedEol: Eol;
  readonly: boolean;
  state: "ready" | "conflict" | "missing" | "readonly" | "error" = "ready";
  error?: string;
  constructor(
    public readonly id: string,
    public path: string,
    snapshot: FileSnapshot,
  ) {
    this.savedRevision = snapshot.revision;
    this.savedText = normalize(snapshot.text);
    this.encoding = this.savedEncoding = snapshot.encoding;
    this.eol = this.savedEol = snapshot.eol;
    this.readonly = snapshot.readonly ?? false;
    if (snapshot.sharedUpdate)
      Y.applyUpdate(
        this.ydoc,
        fromBase64(snapshot.sharedUpdate),
        REMOTE_ORIGIN,
      );
    else
      this.ydoc.transact(
        () => this.text.insert(0, this.savedText),
        DISK_ORIGIN,
      );
    if (this.readonly) this.state = "readonly";
    this.text.observe(() => {
      this.version++;
    });
  }
  get dirty(): boolean {
    return (
      this.text.toString() !== this.savedText ||
      this.encoding !== this.savedEncoding ||
      this.eol !== this.savedEol
    );
  }
  replace(text: string, origin: unknown = LOCAL_ORIGIN): void {
    if (this.readonly && origin === LOCAL_ORIGIN)
      throw new Error(`File is read-only: ${this.path}`);
    const previous = this.text.toString();
    const next = normalize(text);
    if (previous === next) return;
    let from = 0;
    while (
      from < previous.length &&
      from < next.length &&
      previous[from] === next[from]
    )
      from++;
    let end = 0;
    while (
      end < previous.length - from &&
      end < next.length - from &&
      previous[previous.length - 1 - end] === next[next.length - 1 - end]
    )
      end++;
    this.transact(
      [
        {
          from,
          to: previous.length - end,
          insert: next.slice(from, next.length - end),
        },
      ],
      origin,
    );
  }
  transact(edits: TextEdit[], origin: unknown = LOCAL_ORIGIN): void {
    if (this.readonly && origin === LOCAL_ORIGIN)
      throw new Error(`File is read-only: ${this.path}`);
    const sorted = validateEdits(edits, this.text.length);
    this.ydoc.transact(() => {
      for (const edit of sorted.reverse()) {
        if (edit.to > edit.from)
          this.text.delete(edit.from, edit.to - edit.from);
        if (edit.insert) this.text.insert(edit.from, normalize(edit.insert));
      }
    }, origin);
  }
  dispose(): void {
    this.awareness.destroy();
    this.undo.destroy();
    this.ydoc.destroy();
  }
}
function documentPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").includes("..")
  )
    throw new Error(`Invalid workspace path: ${path}`);
  const normalized = path
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  if (!normalized) throw new Error("A file path is required");
  return normalized;
}
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function validateEdits(edits: TextEdit[], length: number): TextEdit[] {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let index = 0; index < sorted.length; index++) {
    const edit = sorted[index]!;
    if (
      !Number.isInteger(edit.from) ||
      !Number.isInteger(edit.to) ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > length ||
      (index > 0 && edit.from < sorted[index - 1]!.to)
    )
      throw new Error("Invalid or overlapping document edits");
  }
  return sorted;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function missing(error: unknown): boolean {
  return (
    /ENOENT|not found|missing|does not exist/i.test(message(error)) ||
    (error instanceof DOMException && error.name === "NotFoundError")
  );
}
function permission(error: unknown): boolean {
  return (
    /EACCES|EPERM|read.only|permission|not allowed/i.test(message(error)) ||
    (error instanceof DOMException && error.name === "NotAllowedError")
  );
}

export class DocumentService {
  readonly documents = new Map<string, DocumentHandle>();
  private readonly listeners = new Set<() => void>();
  private readonly opening = new Map<string, Promise<DocumentHandle>>();
  private readonly saving = new Set<string>();
  private readonly resourceChanges = new Set<string>();
  private readonly watching;
  private readonly pendingChanges = new Map<string, FileChange>();
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private identities?: Promise<Record<string, string>>;
  constructor(
    public readonly filesystem: FileSystem,
    private readonly persistence: Persistence,
    private readonly kernel?: Kernel,
  ) {
    this.watching = filesystem.watch((event) => {
      void this.externalChange(event);
    });
  }
  private get key(): string {
    return `documents:${this.filesystem.id}`;
  }
  private identityMap(): Promise<Record<string, string>> {
    return (this.identities ??= this.persistence
      .get<Record<string, string>>(`document-identities:${this.filesystem.id}`)
      .then((values) => Object.assign(Object.create(null), values ?? {})));
  }
  private async rememberIdentity(path: string, id: string): Promise<void> {
    const identities = await this.identityMap();
    identities[path] = id;
    await this.persistence.set(`document-identities:${this.filesystem.id}`, {
      ...identities,
    });
    await this.persistence.set(`document-id:${this.filesystem.id}:${path}`, id);
  }
  private async changeIdentities(path: string, to?: string): Promise<void> {
    const identities = await this.identityMap();
    for (const previous of Object.keys(identities))
      if (previous === path || previous.startsWith(path + "/")) {
        const id = identities[previous]!;
        delete identities[previous];
        await this.persistence.delete(
          `document-id:${this.filesystem.id}:${previous}`,
        );
        if (to) {
          const target = to + previous.slice(path.length);
          identities[target] = id;
          await this.persistence.set(
            `document-id:${this.filesystem.id}:${target}`,
            id,
          );
        }
      }
    await this.persistence.set(`document-identities:${this.filesystem.id}`, {
      ...identities,
    });
  }
  private readDisk(path: string): Promise<FileSnapshot> {
    return this.filesystem.readDisk
      ? this.filesystem.readDisk(path)
      : this.filesystem.read(path);
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.persist().catch((error) => console.error(error));
    }, 75);
  }
  private attach(document: DocumentHandle): DocumentHandle {
    this.documents.set(document.path, document);
    document.text.observe((event) => {
      this.kernel?.events.emit("document.change", {
        id: document.id,
        version: document.version,
        origin: event.transaction.origin,
      });
      this.changed();
    });
    this.kernel?.events.emit("document.open", {
      id: document.id,
      path: document.path,
    });
    this.changed();
    return document;
  }
  async open(path: string): Promise<DocumentHandle> {
    path = documentPath(path);
    if (this.disposed) throw new Error("Document service is disposed");
    const existing = this.documents.get(path);
    if (existing) return existing;
    const pending = this.opening.get(path);
    if (pending) return pending;
    const opening = (async () => {
      const snapshot = await this.filesystem.read(path);
      if (this.disposed) throw new Error("Document service is disposed");
      const identities = await this.identityMap();
      const id =
        identities[path] ??
        (await this.persistence.get<string>(
          `document-id:${this.filesystem.id}:${path}`,
        )) ??
        crypto.randomUUID();
      await this.rememberIdentity(path, id);
      if (this.disposed) throw new Error("Document service is disposed");
      return this.attach(new DocumentHandle(id, path, snapshot));
    })();
    this.opening.set(path, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(path);
    }
  }
  get(path: string): DocumentHandle | undefined {
    path = documentPath(path);
    return this.documents.get(path);
  }
  setState(path: string, state: DocumentHandle["state"], error?: string): void {
    path = documentPath(path);
    const document = this.documents.get(path);
    if (!document) return;
    document.state = state;
    if (state === "readonly") document.readonly = true;
    else if (state === "ready") document.readonly = false;
    document.error = error;
    this.changed();
  }
  async save(
    path: string,
    signal = new AbortController().signal,
  ): Promise<void> {
    path = documentPath(path);
    const document = await this.open(path);
    if (this.saving.has(path))
      throw new Error(`Recursive or concurrent save blocked: ${path}`);
    if (document.readonly) throw new Error(`File is read-only: ${path}`);
    if (document.state === "conflict")
      throw new Error(`Resolve external changes before saving: ${path}`);
    if (document.state === "missing")
      throw new Error(`File was deleted: ${path}`);
    if (signal.aborted) throw new DOMException("Save cancelled", "AbortError");
    this.saving.add(path);
    try {
      const version = document.version;
      const before = document.text.toString();
      const text = this.kernel
        ? await this.kernel.hooks.runBeforeSave({
            documentId: document.id,
            path,
            text: before,
            signal,
          })
        : before;
      if (signal.aborted)
        throw new DOMException("Save cancelled", "AbortError");
      if (document.version !== version)
        throw new Error("Document changed while save hooks ran; save again");
      if (text !== before) document.replace(text);
      const content = document.text.toString();
      const encoding = document.encoding;
      const eol = document.eol;
      const snapshot = await this.filesystem.write(path, content, {
        expectedRevision: document.savedRevision,
        encoding,
        eol,
      });
      document.savedRevision = snapshot.revision;
      document.savedText = normalize(snapshot.text);
      document.savedEncoding = encoding;
      document.savedEol = eol;
      document.state = snapshot.readonly ? "readonly" : "ready";
      document.readonly = snapshot.readonly ?? false;
      delete document.error;
      this.kernel?.events.emit("document.save", {
        id: document.id,
        revision: snapshot.revision,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      document.error = message(error);
      if (/revision|conflict|stale/i.test(document.error))
        document.state = "conflict";
      else if (missing(error)) document.state = "missing";
      else if (permission(error)) {
        document.state = "readonly";
        document.readonly = true;
      } else document.state = "error";
      throw error;
    } finally {
      this.saving.delete(path);
      this.changed();
      const pending = this.pendingChanges.get(path);
      if (pending) {
        this.pendingChanges.delete(path);
        void this.externalChange(pending);
      }
      await this.persist();
    }
  }
  markSaved(path: string, snapshot: FileSnapshot): void {
    path = documentPath(path);
    const document = this.documents.get(path);
    if (!document) return;
    document.savedRevision = snapshot.revision;
    document.savedText = normalize(snapshot.text);
    if (document.encoding === document.savedEncoding)
      document.encoding = snapshot.encoding;
    if (document.eol === document.savedEol) document.eol = snapshot.eol;
    document.savedEncoding = snapshot.encoding;
    document.savedEol = snapshot.eol;
    document.state = snapshot.readonly ? "readonly" : "ready";
    document.readonly = snapshot.readonly ?? false;
    delete document.error;
    this.changed();
  }
  async reload(path: string): Promise<void> {
    path = documentPath(path);
    const document = await this.open(path);
    const snapshot = await this.readDisk(path);
    if (snapshot.sharedUpdate)
      Y.applyUpdate(
        document.ydoc,
        fromBase64(snapshot.sharedUpdate),
        REMOTE_ORIGIN,
      );
    document.replace(snapshot.text, DISK_ORIGIN);
    document.encoding = snapshot.encoding;
    document.eol = snapshot.eol;
    this.markSaved(path, snapshot);
    document.undo.clear();
    await this.persist();
  }
  async overwriteConflict(path: string): Promise<void> {
    path = documentPath(path);
    const document = await this.open(path);
    const current = await this.readDisk(path);
    document.savedRevision = current.revision;
    document.state = "ready";
    await this.save(path);
  }
  async applyEdits(
    edits: DocumentEdit[],
    resources: ResourceEdit[] = [],
  ): Promise<void> {
    edits = edits.map((edit) => ({ ...edit, path: documentPath(edit.path) }));
    resources = resources.map((resource) => ({
      ...resource,
      path: documentPath(resource.path),
      ...(resource.to ? { to: documentPath(resource.to) } : {}),
    }));
    const seen = new Set<string>();
    const created = new Set(
      resources
        .filter((resource) => resource.kind === "create")
        .map((resource) => resource.path),
    );
    const targets: {
      document: DocumentHandle;
      edits: TextEdit[];
      version: number;
      created: boolean;
    }[] = [];
    const transient: DocumentHandle[] = [];
    try {
      for (const edit of edits) {
        if (seen.has(edit.path))
          throw new Error(`Duplicate document edit: ${edit.path}`);
        seen.add(edit.path);
        const isCreated =
          created.has(edit.path) && !this.documents.has(edit.path);
        const document = isCreated
          ? new DocumentHandle(crypto.randomUUID(), edit.path, {
              path: edit.path,
              text: "",
              revision: "",
              encoding: "utf-8",
              eol: "LF",
            })
          : await this.open(edit.path);
        if (isCreated) transient.push(document);
        if (document.readonly)
          throw new Error(`File is read-only: ${edit.path}`);
        if (
          edit.expectedVersion !== undefined &&
          document.version !== edit.expectedVersion
        )
          throw new Error(`Stale document edit: ${edit.path}`);
        if (edit.expectedRevision !== undefined) {
          const disk = await this.readDisk(edit.path);
          if (
            disk.revision !== edit.expectedRevision ||
            document.savedRevision !== edit.expectedRevision
          )
            throw new Error(`Stale file revision: ${edit.path}`);
        }
        targets.push({
          document,
          edits: validateEdits(edit.edits, document.text.length),
          version: document.version,
          created: isCreated,
        });
      }
      for (const resource of resources) {
        const affected = [...this.documents.values()].filter(
          (document) =>
            document.path === resource.path ||
            document.path.startsWith(resource.path + "/"),
        );
        if (affected.some((document) => document.readonly))
          throw new Error(`File is read-only: ${resource.path}`);
        if (
          resource.kind === "rename" &&
          (!resource.to || resource.to === resource.path)
        )
          throw new Error("Rename requires a distinct destination");
        if (
          resource.kind === "delete" &&
          affected.some((document) => document.dirty)
        )
          throw new Error(`Save changes before deleting: ${resource.path}`);
        if (
          resource.kind === "delete" &&
          edits.some(
            (edit) =>
              edit.path === resource.path ||
              edit.path.startsWith(resource.path + "/"),
          )
        )
          throw new Error(
            `Cannot edit and delete the same file: ${resource.path}`,
          );
        if (resource.kind === "create" || resource.kind === "rename") {
          const destination =
            resource.kind === "create" ? resource.path : resource.to!;
          try {
            await this.filesystem.read(destination);
            throw new Error(`Destination exists: ${destination}`);
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
      }
      for (const target of targets)
        if (target.document.version !== target.version)
          throw new Error(`Stale document edit: ${target.document.path}`);
      for (const path of created) {
        const snapshot = await this.filesystem.write(path, "", {
          expectedRevision: null,
        });
        const target = targets.find(
          (value) => value.document.path === path && value.created,
        );
        if (target) {
          target.document.savedRevision = snapshot.revision;
          await this.rememberIdentity(path, target.document.id);
          this.attach(target.document);
        }
      }
      for (const target of targets)
        if (target.document.version !== target.version)
          throw new Error(`Stale document edit: ${target.document.path}`);
      for (const target of targets) target.document.transact(target.edits);
      for (const resource of resources) {
        if (resource.kind === "create") continue;
        this.resourceChanges.add(resource.path);
        if (resource.to) this.resourceChanges.add(resource.to);
        try {
          if (resource.kind === "rename") {
            await this.filesystem.rename(resource.path, resource.to!);
            await this.changeIdentities(resource.path, resource.to!);
            const affected = [...this.documents.values()].filter(
              (document) =>
                document.path === resource.path ||
                document.path.startsWith(resource.path + "/"),
            );
            for (const document of affected) {
              const previousPath = document.path;
              this.documents.delete(previousPath);
              document.path =
                resource.to! + previousPath.slice(resource.path.length);
              this.documents.set(document.path, document);
              await this.rememberIdentity(document.path, document.id);
            }
          } else {
            await this.filesystem.delete(resource.path);
            await this.changeIdentities(resource.path);
            for (const document of [...this.documents.values()])
              if (
                document.path === resource.path ||
                document.path.startsWith(resource.path + "/")
              ) {
                this.close(document.path);
                await this.persistence.delete(
                  `document-id:${this.filesystem.id}:${document.path}`,
                );
              }
          }
        } finally {
          this.resourceChanges.delete(resource.path);
          if (resource.to) this.resourceChanges.delete(resource.to);
        }
      }
      this.changed();
      await this.persist();
    } finally {
      for (const document of transient)
        if (this.documents.get(document.path) !== document) document.dispose();
    }
  }
  close(path: string): void {
    path = documentPath(path);
    const document = this.documents.get(path);
    if (!document) return;
    if (document.dirty)
      throw new Error(`Save or discard changes before closing: ${path}`);
    this.documents.delete(path);
    document.dispose();
    this.kernel?.events.emit("document.close", { id: document.id });
    this.changed();
  }
  discard(path: string): void {
    path = documentPath(path);
    const document = this.documents.get(path);
    if (!document) return;
    this.documents.delete(path);
    document.dispose();
    this.kernel?.events.emit("document.close", { id: document.id });
    this.changed();
  }
  async restore(): Promise<void> {
    const drafts = (await this.persistence.get<Draft[]>(this.key)) ?? [];
    for (const draft of drafts) {
      if (this.documents.has(draft.path)) continue;
      let snapshot: FileSnapshot;
      let state: DocumentHandle["state"] = "ready";
      let failure: string | undefined;
      try {
        snapshot = await this.filesystem.read(draft.path);
      } catch (error) {
        snapshot = {
          path: draft.path,
          text: draft.savedText,
          revision: draft.savedRevision,
          encoding: draft.encoding,
          eol: draft.eol,
        };
        state = missing(error)
          ? "missing"
          : permission(error)
            ? "readonly"
            : "error";
        failure = message(error);
      }
      const saved = { ...snapshot, text: "", sharedUpdate: undefined };
      const document = new DocumentHandle(draft.id, draft.path, saved);
      Y.applyUpdate(document.ydoc, new Uint8Array(draft.update), REMOTE_ORIGIN);
      document.version = draft.version;
      document.savedRevision = draft.savedRevision;
      document.savedText = draft.savedText;
      document.encoding = draft.encoding;
      document.eol = draft.eol;
      document.savedEncoding = draft.savedEncoding ?? draft.encoding;
      document.savedEol = draft.savedEol ?? draft.eol;
      const wasDirty = document.dirty;
      if (snapshot.sharedUpdate)
        Y.applyUpdate(
          document.ydoc,
          fromBase64(snapshot.sharedUpdate),
          REMOTE_ORIGIN,
        );
      if (snapshot.revision !== draft.savedRevision && state === "ready") {
        if (snapshot.sharedUpdate) {
          if (document.encoding === document.savedEncoding)
            document.encoding = snapshot.encoding;
          if (document.eol === document.savedEol) document.eol = snapshot.eol;
          document.savedText = normalize(snapshot.text);
          document.savedRevision = snapshot.revision;
          document.savedEncoding = snapshot.encoding;
          document.savedEol = snapshot.eol;
        } else if (wasDirty) {
          state = "conflict";
          failure = "Disk changed while this recovery draft was offline";
        } else {
          document.replace(snapshot.text, DISK_ORIGIN);
          document.savedText = normalize(snapshot.text);
          document.savedRevision = snapshot.revision;
          document.encoding = document.savedEncoding = snapshot.encoding;
          document.eol = document.savedEol = snapshot.eol;
        }
      }
      for (const [id, view] of draft.views ?? []) document.views.set(id, view);
      document.state = snapshot.readonly ? "readonly" : state;
      document.readonly = snapshot.readonly ?? state === "readonly";
      document.error = failure;
      await this.rememberIdentity(document.path, document.id);
      this.attach(document);
    }
  }
  private async externalChange(event: FileChange): Promise<void> {
    const document = this.documents.get(event.path);
    if (
      !document ||
      this.disposed ||
      [...this.resourceChanges].some(
        (path) => event.path === path || event.path.startsWith(path + "/"),
      )
    )
      return;
    if (this.saving.has(event.path)) {
      this.pendingChanges.set(event.path, event);
      return;
    }
    if (event.kind === "deleted") {
      document.state = "missing";
      document.error = "File was deleted externally";
      this.changed();
      return;
    }
    try {
      const snapshot = await this.readDisk(event.path);
      if (this.disposed || !this.documents.has(event.path)) return;
      if (snapshot.sharedUpdate)
        Y.applyUpdate(
          document.ydoc,
          fromBase64(snapshot.sharedUpdate),
          REMOTE_ORIGIN,
        );
      if (snapshot.revision === document.savedRevision) {
        if (
          document.readonly !== Boolean(snapshot.readonly) ||
          document.state === "missing" ||
          document.state === "readonly"
        )
          this.setState(event.path, snapshot.readonly ? "readonly" : "ready");
        return;
      }
      if (snapshot.sharedUpdate) {
        this.markSaved(event.path, snapshot);
        return;
      }
      if (
        document.dirty &&
        normalize(snapshot.text) !== document.text.toString()
      ) {
        document.state = "conflict";
        document.error =
          "File changed on disk while this document has unsaved changes";
      } else {
        document.replace(snapshot.text, DISK_ORIGIN);
        document.encoding = snapshot.encoding;
        document.eol = snapshot.eol;
        this.markSaved(event.path, snapshot);
      }
    } catch (error) {
      this.setState(
        event.path,
        missing(error) ? "missing" : permission(error) ? "readonly" : "error",
        message(error),
      );
    }
    this.changed();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  persist(): Promise<void> {
    clearTimeout(this.persistTimer);
    const drafts: Draft[] = [...this.documents.values()].map((document) => ({
      id: document.id,
      path: document.path,
      update: Y.encodeStateAsUpdate(document.ydoc),
      version: document.version,
      savedRevision: document.savedRevision,
      savedText: document.savedText,
      encoding: document.encoding,
      eol: document.eol,
      savedEncoding: document.savedEncoding,
      savedEol: document.savedEol,
      views: [...document.views],
    }));
    const pending = this.persistQueue
      .catch(() => {})
      .then(() => this.persistence.set(this.key, drafts));
    this.persistQueue = pending;
    return pending;
  }
  dispose(): void {
    if (this.disposed) return;
    void this.persist().catch((error) => console.error(error));
    this.disposed = true;
    this.watching.dispose();
    clearTimeout(this.persistTimer);
    for (const document of this.documents.values()) document.dispose();
    this.documents.clear();
    this.listeners.clear();
  }
}
