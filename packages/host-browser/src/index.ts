import type {
  Disposable,
  Encoding,
  Eol,
  FileChange,
  FileEntry,
  FileSnapshot,
  FileSystem,
  HostAdapter,
  Persistence,
  WriteOptions,
} from "@zapp/sdk";

export class IndexedDBPersistence implements Persistence {
  private readonly database: Promise<IDBDatabase>;
  constructor(databaseName = "zapp") {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("data");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not open workspace storage"));
      request.onblocked = () =>
        reject(
          new Error("Workspace storage is blocked by another browser tab"),
        );
    });
  }
  private async operation<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("data", mode);
      const request = operation(transaction.objectStore("data"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () =>
        reject(
          transaction.error ??
            request.error ??
            new Error("Workspace storage failed"),
        );
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("Workspace storage transaction aborted"),
        );
    });
  }
  get<T>(key: string): Promise<T | undefined> {
    return this.operation("readonly", (store) => store.get(key)) as Promise<
      T | undefined
    >;
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.operation("readwrite", (store) => store.put(value, key));
  }
  async delete(key: string): Promise<void> {
    await this.operation("readwrite", (store) => store.delete(key));
  }
  async close(): Promise<void> {
    (await this.database).close();
  }
}

export class MemoryPersistence implements Persistence {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export function normalizePath(path: string, allowRoot = false): string {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === "..")
  )
    throw new Error(`Invalid workspace path: ${path}`);
  const normalized = path
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  if (!normalized && !allowRoot) throw new Error("A file path is required");
  return normalized;
}

export function encodeText(
  text: string,
  encoding: Encoding = "utf-8",
  eol: Eol = "LF",
): Uint8Array {
  if (!["utf-8", "utf-8-bom", "utf-16le", "latin1"].includes(encoding))
    throw new Error(`Unsupported encoding: ${encoding}`);
  if (eol !== "LF" && eol !== "CRLF")
    throw new Error(`Unsupported line ending: ${eol}`);
  const normalized = text.replace(/\r\n/g, "\n");
  const content =
    eol === "CRLF" ? normalized.replace(/\n/g, "\r\n") : normalized;
  if (encoding === "latin1") {
    const bytes = new Uint8Array(content.length);
    for (let index = 0; index < content.length; index++) {
      const code = content.charCodeAt(index);
      if (code > 255)
        throw new Error(
          `Latin-1 cannot encode U+${code.toString(16).toUpperCase()} at offset ${index}`,
        );
      bytes[index] = code;
    }
    return bytes;
  }
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error("Text contains an unpaired UTF-16 surrogate");
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new Error("Text contains an unpaired UTF-16 surrogate");
  }
  if (encoding === "utf-16le") {
    const bytes = new Uint8Array(content.length * 2 + 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let index = 0; index < content.length; index++) {
      const code = content.charCodeAt(index);
      bytes[index * 2 + 2] = code & 255;
      bytes[index * 2 + 3] = code >> 8;
    }
    return bytes;
  }
  const bytes = new TextEncoder().encode(content);
  if (encoding === "utf-8-bom") {
    const result = new Uint8Array(bytes.length + 3);
    result.set([0xef, 0xbb, 0xbf]);
    result.set(bytes, 3);
    return result;
  }
  return bytes;
}

export function decodeText(
  bytes: Uint8Array,
  requested?: Encoding,
): { text: string; encoding: Encoding; eol: Eol } {
  let encoding: Encoding = requested ?? "utf-8";
  let offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8-bom";
    offset = 3;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff)
    throw new Error("UTF-16BE is not supported; convert the file to UTF-8");
  const content = bytes.subarray(offset);
  let text: string;
  if (encoding === "latin1") {
    const characters: string[] = [];
    for (let index = 0; index < content.length; index += 8192)
      characters.push(
        String.fromCharCode(...content.subarray(index, index + 8192)),
      );
    text = characters.join("");
  } else {
    try {
      text = new TextDecoder(encoding === "utf-16le" ? "utf-16le" : "utf-8", {
        fatal: true,
      }).decode(content);
    } catch {
      throw new Error(
        `Invalid ${encoding} input; import with an explicit supported encoding`,
      );
    }
  }
  if (text.includes("\0"))
    throw new Error(
      "Binary files are not supported by the text document provider",
    );
  return {
    text: text.replace(/\r\n/g, "\n"),
    encoding,
    eol: text.includes("\r\n") ? "CRLF" : "LF",
  };
}

interface StoredFile {
  text: string;
  revision: string;
  encoding: Encoding;
  eol: Eol;
  readonly?: boolean;
}
interface StoredWorkspace {
  version: 1;
  files: Record<string, StoredFile>;
  directories: string[];
}
export interface WorkspaceArchive {
  version?: 1;
  files: { path: string; text: string; encoding?: Encoding; eol?: Eol }[];
  directories?: string[];
}
const locks = new WeakMap<Persistence, Map<string, Promise<unknown>>>();

export class BrowserFileSystem implements FileSystem {
  private readonly listeners = new Set<(event: FileChange) => void>();
  private readonly channel?: BroadcastChannel;
  constructor(
    private readonly persistence: Persistence,
    public readonly id = "browser",
  ) {
    if (
      typeof window !== "undefined" &&
      typeof BroadcastChannel !== "undefined"
    ) {
      this.channel = new BroadcastChannel(`zapp-files:${id}`);
      this.channel.onmessage = (event) => {
        const change = event.data as FileChange;
        if (
          change &&
          ["created", "changed", "deleted"].includes(change.kind) &&
          typeof change.path === "string"
        )
          this.emit(change, false);
      };
    }
  }
  private get key(): string {
    return `filesystem:${this.id}`;
  }
  private async state(): Promise<StoredWorkspace> {
    const state = (await this.persistence.get<StoredWorkspace>(this.key)) ?? {
      version: 1,
      files: {},
      directories: [],
    };
    state.files = Object.assign(Object.create(null), state.files) as Record<
      string,
      StoredFile
    >;
    return state;
  }
  private async mutate<T>(
    operation: (state: StoredWorkspace, changes: FileChange[]) => T,
  ): Promise<T> {
    const perform = async () => {
      const state = await this.state();
      const changes: FileChange[] = [];
      const result = operation(state, changes);
      await this.persistence.set(this.key, state);
      for (const change of changes) this.emit(change);
      return result;
    };
    if (typeof navigator !== "undefined" && navigator.locks)
      return navigator.locks.request(`zapp:${this.id}`, perform);
    const pending =
      locks.get(this.persistence) ?? new Map<string, Promise<unknown>>();
    locks.set(this.persistence, pending);
    const next = (pending.get(this.id) ?? Promise.resolve())
      .catch(() => {})
      .then(perform);
    pending.set(this.id, next);
    return next;
  }
  private emit(event: FileChange, broadcast = true): void {
    for (const listener of this.listeners) listener(event);
    if (broadcast) this.channel?.postMessage(event);
  }
  async list(path = ""): Promise<FileEntry[]> {
    const directory = normalizePath(path, true);
    const prefix = directory ? `${directory}/` : "";
    const state = await this.state();
    const entries = new Map<string, FileEntry>();
    for (const name of [...state.directories, ...Object.keys(state.files)]) {
      if (!name.startsWith(prefix)) continue;
      const relative = name.slice(prefix.length);
      if (!relative) continue;
      const basename = relative.split("/")[0]!;
      const entryPath = `${prefix}${basename}`;
      const file = state.files[entryPath];
      const isDirectory = relative.includes("/") || !file;
      entries.set(entryPath, {
        path: entryPath,
        name: basename,
        kind: isDirectory ? "directory" : "file",
        ...(file
          ? {
              size: encodeText(file.text, file.encoding, file.eol).length,
              readonly: file.readonly,
              revision: file.revision,
            }
          : {}),
      });
    }
    return [...entries.values()].sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name),
    );
  }
  async read(path: string): Promise<FileSnapshot> {
    path = normalizePath(path);
    const file = (await this.state()).files[path];
    if (!file) throw new Error(`File not found: ${path}`);
    return { path, ...file };
  }
  async write(
    path: string,
    text: string,
    options: WriteOptions,
  ): Promise<FileSnapshot> {
    path = normalizePath(path);
    return this.mutate((state, changes) => {
      const current = state.files[path];
      if (state.directories.includes(path))
        throw new Error(`Path is a directory: ${path}`);
      if (current?.readonly) throw new Error(`File is read-only: ${path}`);
      if (options.expectedRevision !== (current?.revision ?? null))
        throw new Error(`File revision conflict: ${path}`);
      const encoding = options.encoding ?? current?.encoding ?? "utf-8";
      const eol = options.eol ?? current?.eol ?? "LF";
      encodeText(text, encoding, eol);
      const parent = path.split("/").slice(0, -1);
      for (let index = 1; index <= parent.length; index++) {
        const directory = parent.slice(0, index).join("/");
        if (state.files[directory])
          throw new Error(`Parent path is a file: ${directory}`);
        if (!state.directories.includes(directory))
          state.directories.push(directory);
      }
      const file: StoredFile = {
        text: text.replace(/\r\n/g, "\n"),
        revision: crypto.randomUUID(),
        encoding,
        eol,
      };
      state.files[path] = file;
      changes.push({ path, kind: current ? "changed" : "created" });
      return { path, ...file };
    });
  }
  async mkdir(path: string): Promise<void> {
    path = normalizePath(path);
    await this.mutate((state, changes) => {
      const parts = path.split("/");
      for (let index = 1; index <= parts.length; index++) {
        const directory = parts.slice(0, index).join("/");
        if (state.files[directory])
          throw new Error(`Path is a file: ${directory}`);
        if (!state.directories.includes(directory)) {
          state.directories.push(directory);
          changes.push({ path: directory, kind: "created" });
        }
      }
    });
  }
  async rename(path: string, to: string): Promise<void> {
    path = normalizePath(path);
    to = normalizePath(to);
    if (to === path || to.startsWith(`${path}/`))
      throw new Error("Invalid rename destination");
    await this.mutate((state, changes) => {
      if (!state.files[path] && !state.directories.includes(path))
        throw new Error(`Path not found: ${path}`);
      if (state.files[to] || state.directories.includes(to))
        throw new Error(`Destination exists: ${to}`);
      const sources = Object.keys(state.files).filter(
        (name) => name === path || name.startsWith(`${path}/`),
      );
      for (const source of sources)
        if (state.files[source]!.readonly)
          throw new Error(`File is read-only: ${source}`);
      for (const source of sources) {
        const target = to + source.slice(path.length);
        state.files[target] = state.files[source]!;
        delete state.files[source];
        changes.push(
          { path: source, kind: "deleted" },
          { path: target, kind: "created" },
        );
      }
      state.directories = state.directories.map((directory) =>
        directory === path || directory.startsWith(`${path}/`)
          ? to + directory.slice(path.length)
          : directory,
      );
      const parents = to.split("/").slice(0, -1);
      for (let index = 1; index <= parents.length; index++) {
        const directory = parents.slice(0, index).join("/");
        if (state.files[directory])
          throw new Error(`Parent path is a file: ${directory}`);
        if (!state.directories.includes(directory))
          state.directories.push(directory);
      }
      changes.push({ path, kind: "deleted" }, { path: to, kind: "created" });
    });
  }
  async delete(path: string): Promise<void> {
    path = normalizePath(path);
    await this.mutate((state, changes) => {
      if (!state.files[path] && !state.directories.includes(path))
        throw new Error(`Path not found: ${path}`);
      const sources = Object.keys(state.files).filter(
        (name) => name === path || name.startsWith(`${path}/`),
      );
      for (const source of sources)
        if (state.files[source]!.readonly)
          throw new Error(`File is read-only: ${source}`);
      for (const source of sources) {
        delete state.files[source];
        changes.push({ path: source, kind: "deleted" });
      }
      state.directories = state.directories.filter(
        (directory) => directory !== path && !directory.startsWith(`${path}/`),
      );
      changes.push({ path, kind: "deleted" });
    });
  }
  watch(listener: (event: FileChange) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
  async export(): Promise<WorkspaceArchive> {
    const state = await this.state();
    return {
      version: 1,
      files: Object.entries(state.files).map(([path, file]) => ({
        path,
        text: file.text,
        encoding: file.encoding,
        eol: file.eol,
      })),
      directories: state.directories,
    };
  }
  async import(archive: WorkspaceArchive, replace = false): Promise<void> {
    if (
      !archive ||
      !Array.isArray(archive.files) ||
      (archive.version !== undefined && archive.version !== 1)
    )
      throw new Error("Invalid workspace archive");
    const files = archive.files.map((file) => {
      const path = normalizePath(file.path);
      if (typeof file.text !== "string")
        throw new Error(`Invalid text for ${path}`);
      const encoding = file.encoding ?? "utf-8";
      const eol = file.eol ?? "LF";
      encodeText(file.text, encoding, eol);
      return { path, text: file.text.replace(/\r\n/g, "\n"), encoding, eol };
    });
    if (new Set(files.map((file) => file.path)).size !== files.length)
      throw new Error("Workspace archive contains duplicate paths");
    const directories = (archive.directories ?? []).map((path) =>
      normalizePath(path),
    );
    await this.mutate((state, changes) => {
      if (replace) {
        for (const [path, file] of Object.entries(state.files))
          if (file.readonly) throw new Error(`File is read-only: ${path}`);
        for (const path of Object.keys(state.files))
          changes.push({ path, kind: "deleted" });
        state.files = Object.create(null) as Record<string, StoredFile>;
        state.directories = [];
      }
      for (const directory of directories)
        if (!state.directories.includes(directory))
          state.directories.push(directory);
      for (const file of files) {
        const current = state.files[file.path];
        if (current?.readonly)
          throw new Error(`File is read-only: ${file.path}`);
        state.files[file.path] = {
          text: file.text,
          revision: crypto.randomUUID(),
          encoding: file.encoding,
          eol: file.eol,
        };
        changes.push({
          path: file.path,
          kind: current ? "changed" : "created",
        });
        const parents = file.path.split("/").slice(0, -1);
        for (let index = 1; index <= parents.length; index++) {
          const directory = parents.slice(0, index).join("/");
          if (!state.directories.includes(directory))
            state.directories.push(directory);
        }
      }
      for (const directory of state.directories)
        if (state.files[directory])
          throw new Error(
            `Archive path is both file and directory: ${directory}`,
          );
    });
  }
  dispose(): void {
    this.channel?.close();
    this.listeners.clear();
  }
}

type DirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemFileHandle | DirectoryHandle>;
  queryPermission?(options: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
};
type PickerWindow = Window & {
  showDirectoryPicker?: (options: {
    mode: "readwrite";
    id: string;
  }) => Promise<DirectoryHandle>;
};

export class DirectoryFileSystem implements FileSystem {
  readonly id: string;
  private readonly listeners = new Set<(event: FileChange) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private versions = new Map<string, string>();
  private polling = false;
  private readonly encodingHints = new Map<string, Encoding>();
  private readonly hintsReady: Promise<void>;
  constructor(
    private readonly handle: FileSystemDirectoryHandle,
    id?: string,
    private readonly persistence?: Persistence,
  ) {
    this.id = id ?? `directory:${handle.name}`;
    this.hintsReady = persistence
      ? persistence
          .get<[string, Encoding][]>(`directory-encodings:${this.id}`)
          .then((values) => {
            for (const [path, encoding] of values ?? [])
              this.encodingHints.set(path, encoding);
          })
      : Promise.resolve();
  }
  private async storeHints(): Promise<void> {
    await this.persistence?.set(`directory-encodings:${this.id}`, [
      ...this.encodingHints,
    ]);
  }
  private async directory(path = "", create = false): Promise<DirectoryHandle> {
    const normalized = normalizePath(path, true);
    let directory = this.handle as DirectoryHandle;
    for (const name of normalized.split("/").filter(Boolean))
      directory = (await directory.getDirectoryHandle(name, {
        create,
      })) as DirectoryHandle;
    return directory;
  }
  private async parent(
    path: string,
    create = false,
  ): Promise<{ directory: DirectoryHandle; name: string }> {
    const parts = normalizePath(path).split("/");
    const name = parts.pop()!;
    return { directory: await this.directory(parts.join("/"), create), name };
  }
  private async snapshot(path: string, file: File): Promise<FileSnapshot> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const revision = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await this.hintsReady;
    return {
      path,
      ...decodeText(bytes, this.encodingHints.get(path)),
      revision,
    };
  }
  async list(path = ""): Promise<FileEntry[]> {
    path = normalizePath(path, true);
    const directory = await this.directory(path);
    const entries: FileEntry[] = [];
    for await (const entry of directory.values()) {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        const file = await entry.getFile();
        entries.push({
          path: entryPath,
          name: entry.name,
          kind: "file",
          size: file.size,
        });
      } else
        entries.push({ path: entryPath, name: entry.name, kind: "directory" });
    }
    return entries.sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name),
    );
  }
  async read(path: string): Promise<FileSnapshot> {
    path = normalizePath(path);
    const { directory, name } = await this.parent(path);
    return this.snapshot(
      path,
      await (await directory.getFileHandle(name)).getFile(),
    );
  }
  async write(
    path: string,
    text: string,
    options: WriteOptions,
  ): Promise<FileSnapshot> {
    path = normalizePath(path);
    const write = async () => {
      let previous: FileSnapshot | undefined;
      try {
        previous = await this.read(path);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError"))
          throw error;
      }
      if ((previous?.revision ?? null) !== options.expectedRevision)
        throw new Error(`File revision conflict: ${path}`);
      const bytes = encodeText(
        text,
        options.encoding ?? previous?.encoding ?? "utf-8",
        options.eol ?? previous?.eol ?? "LF",
      );
      const { directory, name } = await this.parent(path, true);
      const handle = await directory.getFileHandle(name, { create: true });
      const writer = await handle.createWritable({ keepExistingData: false });
      try {
        await writer.write(bytes as Uint8Array<ArrayBuffer>);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
      await this.hintsReady;
      this.encodingHints.set(
        path,
        options.encoding ?? previous?.encoding ?? "utf-8",
      );
      await this.storeHints();
      const snapshot = await this.read(path);
      this.emit({ path, kind: previous ? "changed" : "created" });
      return snapshot;
    };
    return typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request(`zapp:${this.id}:${path}`, write)
      : write();
  }
  async mkdir(path: string): Promise<void> {
    await this.directory(path, true);
    this.emit({ path: normalizePath(path), kind: "created" });
  }
  async rename(path: string, to: string): Promise<void> {
    path = normalizePath(path);
    to = normalizePath(to);
    if (to === path || to.startsWith(`${path}/`))
      throw new Error("Invalid rename destination");
    const source = await this.parent(path);
    const destination = await this.parent(to, true);
    try {
      await destination.directory.getFileHandle(destination.name);
      throw new Error(`Destination exists: ${to}`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError"))
        throw error;
    }
    try {
      await destination.directory.getDirectoryHandle(destination.name);
      throw new Error(`Destination exists: ${to}`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError"))
        throw error;
    }
    const copy = async (from: string, target: string): Promise<void> => {
      const origin = await this.parent(from),
        destination = await this.parent(target, true);
      let file: File;
      try {
        file = await (
          await origin.directory.getFileHandle(origin.name)
        ).getFile();
      } catch (error) {
        if (!(
          error instanceof DOMException && error.name === "TypeMismatchError"
        ))
          throw error;
        await this.directory(target, true);
        for (const child of await this.list(from))
          await copy(child.path, `${target}/${child.name}`);
        return;
      }
      const writer = await (
        await destination.directory.getFileHandle(destination.name, {
          create: true,
        })
      ).createWritable({ keepExistingData: false });
      try {
        await writer.write(file);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
    };
    try {
      await copy(path, to);
    } catch (error) {
      await destination.directory
        .removeEntry(destination.name, { recursive: true })
        .catch(() => {});
      throw error;
    }
    await source.directory.removeEntry(source.name, { recursive: true });
    await this.hintsReady;
    for (const [name, encoding] of [...this.encodingHints])
      if (name === path || name.startsWith(path + "/")) {
        this.encodingHints.delete(name);
        this.encodingHints.set(to + name.slice(path.length), encoding);
      }
    await this.storeHints();
    this.emit({ path, kind: "deleted" }, { path: to, kind: "created" });
  }
  async delete(path: string): Promise<void> {
    const { directory, name } = await this.parent(path);
    await directory.removeEntry(name, { recursive: true });
    await this.hintsReady;
    for (const name of [...this.encodingHints.keys()])
      if (name === path || name.startsWith(path + "/"))
        this.encodingHints.delete(name);
    await this.storeHints();
    this.emit({ path: normalizePath(path), kind: "deleted" });
  }
  private emit(...events: FileChange[]): void {
    for (const event of events)
      for (const listener of this.listeners) listener(event);
  }
  watch(listener: (event: FileChange) => void): Disposable {
    this.listeners.add(listener);
    if (!this.timer) {
      void this.poll(true);
      this.timer = setInterval(() => {
        void this.poll();
      }, 2000);
    }
    return {
      dispose: () => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      },
    };
  }
  private async poll(initial = false): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const next = new Map<string, string>();
      let count = 0;
      let truncated = false;
      const scan = async (path: string): Promise<void> => {
        for (const entry of await this.list(path)) {
          if (++count > 10000) {
            truncated = true;
            return;
          }
          if (entry.kind === "directory") {
            if (!["node_modules", ".git"].includes(entry.name))
              await scan(entry.path);
          } else {
            const { directory, name } = await this.parent(entry.path);
            const file = await (await directory.getFileHandle(name)).getFile();
            next.set(entry.path, `${file.lastModified}:${file.size}`);
          }
        }
      };
      await scan("");
      if (!initial) {
        for (const [path, revision] of next) {
          const previous = this.versions.get(path);
          if (previous !== revision)
            this.emit({ path, kind: previous ? "changed" : "created" });
        }
        for (const path of this.versions.keys())
          if (!truncated && !next.has(path))
            this.emit({ path, kind: "deleted" });
      }
      this.versions = truncated ? new Map([...this.versions, ...next]) : next;
    } catch (error) {
      console.error(error);
    } finally {
      this.polling = false;
    }
  }
  dispose(): void {
    clearInterval(this.timer);
    this.listeners.clear();
  }
}

interface SavedDirectory {
  handle: DirectoryHandle;
  id: string;
}

export async function restoreDirectory(
  persistence: Persistence,
): Promise<DirectoryFileSystem | undefined> {
  const recent = await persistence.get<SavedDirectory>("directory:recent");
  if (!recent?.handle?.queryPermission) return undefined;
  try {
    if (
      (await recent.handle.queryPermission({ mode: "readwrite" })) !== "granted"
    )
      return undefined;
  } catch {
    return undefined;
  }
  return new DirectoryFileSystem(recent.handle, recent.id, persistence);
}

export async function pickDirectory(
  persistence: Persistence,
): Promise<FileSystem> {
  const picker =
    typeof window !== "undefined"
      ? (window as PickerWindow).showDirectoryPicker
      : undefined;
  if (!picker) return new BrowserFileSystem(persistence);
  const handle = await picker.call(window, {
    mode: "readwrite",
    id: "zapp-workspace",
  });
  const known =
    (await persistence.get<SavedDirectory[]>("directory:known")) ?? [];
  const recent = await persistence.get<SavedDirectory>("directory:recent");
  if (recent && !known.some((value) => value.id === recent.id))
    known.push(recent);
  let match: SavedDirectory | undefined;
  for (const directory of known) {
    try {
      if (await handle.isSameEntry(directory.handle)) {
        match = directory;
        break;
      }
    } catch {}
  }
  const saved = { handle, id: match?.id ?? `directory:${crypto.randomUUID()}` };
  await persistence.set("directory:recent", saved);
  await persistence.set(
    "directory:known",
    [saved, ...known.filter((value) => value.id !== saved.id)].slice(0, 20),
  );
  return new DirectoryFileSystem(handle, saved.id, persistence);
}

export async function createBrowserHost(
  persistence: Persistence = new IndexedDBPersistence(),
): Promise<HostAdapter> {
  const filesystem =
    (await restoreDirectory(persistence)) ?? new BrowserFileSystem(persistence);
  return {
    environment: "browser",
    filesystem,
    persistence,
    pickDirectory: () => pickDirectory(persistence),
    ...(typeof navigator !== "undefined" && navigator.clipboard
      ? {
          clipboard: {
            readText: () => navigator.clipboard.readText(),
            writeText: (text: string) => navigator.clipboard.writeText(text),
          },
        }
      : {}),
  };
}
