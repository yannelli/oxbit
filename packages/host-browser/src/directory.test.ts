import { afterEach, describe, expect, it, vi } from "vitest";
import type { Persistence } from "@zapp/sdk";
import {
  BrowserFileSystem,
  DirectoryFileSystem,
  MemoryPersistence,
  pickDirectory,
  restoreDirectory,
} from "./index";

class NativeFile {
  readonly kind = "file";
  bytes = new Uint8Array();
  modified = 0;
  constructor(readonly name: string) {}
  async getFile(): Promise<File> {
    return new File([this.bytes.slice().buffer], this.name, {
      lastModified: this.modified,
    });
  }
  async createWritable() {
    let pending = this.bytes;
    return {
      write: async (value: Blob | Uint8Array) => {
        pending =
          value instanceof Blob
            ? new Uint8Array(await value.arrayBuffer())
            : new Uint8Array(value);
      },
      close: async () => {
        this.bytes = pending;
        this.modified++;
      },
      abort: async () => {},
    };
  }
}
class NativeDirectory {
  readonly kind = "directory";
  readonly entries = new Map<string, NativeFile | NativeDirectory>();
  constructor(readonly name: string) {}
  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<NativeFile> {
    let entry = this.entries.get(name);
    if (entry?.kind === "directory")
      throw new DOMException("Directory", "TypeMismatchError");
    if (!entry && options?.create) {
      entry = new NativeFile(name);
      this.entries.set(name, entry);
    }
    if (!entry) throw new DOMException("Missing file", "NotFoundError");
    return entry as NativeFile;
  }
  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<NativeDirectory> {
    let entry = this.entries.get(name);
    if (entry?.kind === "file")
      throw new DOMException("File", "TypeMismatchError");
    if (!entry && options?.create) {
      entry = new NativeDirectory(name);
      this.entries.set(name, entry);
    }
    if (!entry) throw new DOMException("Missing directory", "NotFoundError");
    return entry as NativeDirectory;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.entries.delete(name))
      throw new DOMException("Missing entry", "NotFoundError");
  }
  async *values() {
    yield* this.entries.values();
  }
  async isSameEntry(other: NativeDirectory): Promise<boolean> {
    return other === this;
  }
  async queryPermission(): Promise<PermissionState> {
    return "granted";
  }
}
const handle = (directory: NativeDirectory) =>
  directory as unknown as FileSystemDirectoryHandle;
const references = (): Persistence => {
  const entries = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => entries.get(key) as T | undefined,
    set: async (key, value) => {
      entries.set(key, value);
    },
    delete: async (key) => {
      entries.delete(key);
    },
  };
};
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native directory provider", () => {
  it("saves Latin-1 and remembers its encoding when the workspace reopens", async () => {
    const root = new NativeDirectory("workspace"),
      persistence = new MemoryPersistence();
    const filesystem = new DirectoryFileSystem(
      handle(root),
      "native",
      persistence,
    );
    const saved = await filesystem.write("cafe.txt", "café\nnext", {
      expectedRevision: null,
      encoding: "latin1",
      eol: "CRLF",
    });
    expect(saved.text).toBe("café\nnext");
    expect(saved.encoding).toBe("latin1");
    expect(saved.eol).toBe("CRLF");
    const restored = new DirectoryFileSystem(
      handle(root),
      "native",
      persistence,
    );
    expect(await restored.read("cafe.txt")).toMatchObject({
      text: "café\nnext",
      encoding: "latin1",
      revision: saved.revision,
    });
  });
  it("renames directories containing binary files without decoding their bytes", async () => {
    const root = new NativeDirectory("workspace"),
      source = await root.getDirectoryHandle("source", { create: true });
    const binary = await source.getFileHandle("image.bin", { create: true });
    binary.bytes = new Uint8Array([0xff, 0x00, 0xfe, 0x80]);
    const filesystem = new DirectoryFileSystem(handle(root));
    await filesystem.rename("source", "renamed");
    const renamed = await (
      await root.getDirectoryHandle("renamed")
    ).getFileHandle("image.bin");
    expect([...renamed.bytes]).toEqual([0xff, 0x00, 0xfe, 0x80]);
    expect(root.entries.has("source")).toBe(false);
  });
  it("reuses a selected directory identity and falls back when permission cannot be restored", async () => {
    const root = new NativeDirectory("workspace"),
      persistence = references();
    vi.stubGlobal("window", { showDirectoryPicker: async () => root });
    const first = await pickDirectory(persistence),
      second = await pickDirectory(persistence);
    expect(first.id).toBe(second.id);
    expect((await restoreDirectory(persistence))?.id).toBe(first.id);
    root.queryPermission = async () => {
      throw new DOMException("Revoked", "NotAllowedError");
    };
    expect(await restoreDirectory(persistence)).toBeUndefined();
  });
  it("keeps the persisted workspace fallback when the picker is unavailable", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("BroadcastChannel", undefined);
    const persistence = new MemoryPersistence(),
      original = new BrowserFileSystem(persistence);
    await original.write("existing.txt", "kept", { expectedRevision: null });
    const fallback = await pickDirectory(persistence);
    expect(fallback.id).toBe("browser");
    expect((await fallback.read("existing.txt")).text).toBe("kept");
    fallback.dispose?.();
    original.dispose();
  });
  it("rejects replacement imports that would delete a read-only file", async () => {
    const persistence = new MemoryPersistence(),
      filesystem = new BrowserFileSystem(persistence);
    await persistence.set("filesystem:browser", {
      version: 1,
      directories: [],
      files: {
        "readonly.txt": {
          text: "preserved",
          revision: "1",
          encoding: "utf-8",
          eol: "LF",
          readonly: true,
        },
      },
    });
    await expect(
      filesystem.import({ files: [{ path: "new.txt", text: "new" }] }, true),
    ).rejects.toThrow("read-only");
    expect((await filesystem.read("readonly.txt")).text).toBe("preserved");
    expect((await filesystem.list()).map((entry) => entry.path)).toEqual([
      "readonly.txt",
    ]);
  });
});
