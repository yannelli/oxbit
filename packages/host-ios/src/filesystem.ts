import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { decodeText, encodeText, normalizePath } from "@oxbit/host-browser";
import type { Disposable, Encoding, FileChange, FileEntry, FileSnapshot, FileSystem, WriteOptions } from "@oxbit/sdk";
import { native, ssh, type OpenedRoot } from "./native.js";
import { findRootFiles, searchRoot } from "./search.js";

type RootCommands = Pick<typeof native, "list" | "read" | "write" | "mkdir" | "rename" | "delete" | "closeRoot">;

/** SHA-256 hex of the raw bytes, the same revision scheme the Rust side checks on write. */
export async function revisionOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class IosFileSystem implements FileSystem {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  /** Device roots only; SFTP roots keep the workbench's JS walk. */
  readonly search?: FileSystem["search"];
  readonly findFiles?: FileSystem["findFiles"];
  private readonly listeners = new Set<(event: FileChange) => void>();
  private readonly encodings = new Map<string, Encoding>();
  private subscription?: Promise<UnlistenFn>;
  private closing?: Promise<void>;
  constructor(opened: OpenedRoot, protected readonly commands: RootCommands = native) {
    this.id = opened.id;
    this.name = opened.name;
    this.root = opened.root;
    if (commands === native) {
      this.search = (options, signal) => searchRoot(this.id, options, signal);
      this.findFiles = (query, signal) => findRootFiles(this.id, query, signal);
    }
  }
  static async open(path: string): Promise<IosFileSystem> {
    return new IosFileSystem(await native.openRoot(path));
  }
  list(path = ""): Promise<FileEntry[]> {
    return this.commands.list(this.id, path ? normalizePath(path) : "");
  }
  async read(path: string): Promise<FileSnapshot> {
    const normalized = normalizePath(path);
    const bytes = new Uint8Array(await this.commands.read(this.id, normalized));
    const decoded = decodeText(bytes, this.encodings.get(normalized));
    this.encodings.set(normalized, decoded.encoding);
    return { path: normalized, ...decoded, revision: await revisionOf(bytes) };
  }
  readDisk(path: string): Promise<FileSnapshot> {
    return this.read(path);
  }
  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.commands.read(this.id, normalizePath(path)));
  }
  async write(path: string, text: string, options: WriteOptions): Promise<FileSnapshot> {
    const normalized = normalizePath(path);
    const encoding = options.encoding ?? this.encodings.get(normalized) ?? "utf-8";
    const eol = options.eol ?? "LF";
    const bytes = encodeText(text, encoding, eol);
    const result = await this.commands.write(this.id, normalized, bytes, options.expectedRevision);
    this.encodings.set(normalized, encoding);
    return { path: normalized, text: text.replace(/\r\n/g, "\n"), revision: result.revision, encoding, eol };
  }
  mkdir(path: string): Promise<void> {
    return this.commands.mkdir(this.id, normalizePath(path));
  }
  rename(path: string, to: string): Promise<void> {
    return this.commands.rename(this.id, normalizePath(path), normalizePath(to));
  }
  delete(path: string): Promise<void> {
    return this.commands.delete(this.id, normalizePath(path));
  }
  watch(listener: (event: FileChange) => void): Disposable {
    this.listeners.add(listener);
    this.subscription ??= this.startWatching();
    return {
      dispose: () => {
        this.listeners.delete(listener);
        if (!this.listeners.size) void this.stopWatching();
      },
    };
  }
  private async startWatching(): Promise<UnlistenFn> {
    const unlisten = await listen<FileChange>(`ios-fs-change:${this.id}`, (event) => {
      for (const listener of this.listeners) listener(event.payload);
    });
    await native.watch(this.id).catch((error) => {
      unlisten();
      throw error;
    });
    return unlisten;
  }
  private async stopWatching() {
    const subscription = this.subscription;
    this.subscription = undefined;
    if (!subscription) return;
    (await subscription)();
    await native.unwatch(this.id).catch(() => {});
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.listeners.clear();
      try { await this.stopWatching(); }
      finally { await this.commands.closeRoot(this.id); }
    })();
  }
  dispose(): Promise<void> {
    return this.close();
  }
}

/** An SFTP root on the host's pooled connection. SFTP has no change events, so `watch` is inert. */
export class SshFileSystem extends IosFileSystem {
  constructor(opened: OpenedRoot, readonly hostId: string) {
    super(opened, ssh);
  }
  static async connect(hostId: string, path: string): Promise<SshFileSystem> {
    return new SshFileSystem(await ssh.openRoot(hostId, path), hostId);
  }
  override watch(): Disposable {
    return { dispose: () => {} };
  }
}
