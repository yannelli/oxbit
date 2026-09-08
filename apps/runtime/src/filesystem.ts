import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type {
  Encoding,
  Eol,
  FileEntry,
  FileSnapshot,
  WriteOptions,
} from "@oxbit/sdk";
import { RpcError } from "@oxbit/protocol";

export function revision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function decode(
  bytes: Buffer,
  requested?: Encoding,
): { text: string; encoding: Encoding; eol: Eol } {
  const encoding: Encoding =
    requested ??
    (bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        ? "utf-8-bom"
        : "utf-8");
  if (!["utf-8", "utf-8-bom", "utf-16le", "latin1"].includes(encoding))
    throw new RpcError("INVALID_PARAMS", "Unsupported encoding");
  let content = bytes;
  if (
    encoding === "utf-8-bom" &&
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  )
    content = bytes.subarray(3);
  if (
    encoding === "utf-16le" &&
    bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
  )
    content = bytes.subarray(2);
  let text: string;
  try {
    if (encoding === "latin1") text = content.toString("latin1");
    else {
      if (encoding === "utf-16le" && content.length % 2)
        throw new Error("Odd UTF-16 byte count");
      text = new TextDecoder(encoding === "utf-16le" ? "utf-16le" : "utf-8", {
        fatal: true,
      }).decode(content);
    }
  } catch {
    throw new RpcError(
      "ENCODING",
      `Cannot decode file as ${encoding}; choose its encoding explicitly`,
    );
  }
  const eol = text.includes("\r\n") ? "CRLF" : "LF";
  return { text: text.replace(/\r\n/g, "\n"), encoding, eol };
}
export function encode(
  text: string,
  encoding: Encoding = "utf-8",
  eol: Eol = "LF",
): Buffer {
  if (
    !["utf-8", "utf-8-bom", "utf-16le", "latin1"].includes(encoding) ||
    !["LF", "CRLF"].includes(eol)
  )
    throw new RpcError("INVALID_PARAMS", "Unsupported encoding or line ending");
  if (
    Array.from(text).some((character) => {
      const point = character.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    })
  )
    throw new RpcError(
      "ENCODING",
      "Text contains an unpaired Unicode surrogate",
    );
  const content = text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n/g, eol === "CRLF" ? "\r\n" : "\n");
  if (encoding === "latin1") {
    if (Array.from(content).some((c) => c.codePointAt(0)! > 255))
      throw new RpcError(
        "ENCODING",
        "Text contains characters outside Latin-1",
      );
    return Buffer.from(content, "latin1");
  }
  if (encoding === "utf-16le")
    return Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(content, "utf16le"),
    ]);
  const bytes = Buffer.from(content, "utf8");
  return encoding === "utf-8-bom"
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
    : bytes;
}

export class WorkspaceFiles {
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    readonly root: string,
    readonly privateRoot?: string,
  ) {
    // macOS /var and /tmp aliases must share the same security boundary as their real paths.
    this.root = realpathSync(root);
    if (privateRoot) this.privateRoot = realpathSync(privateRoot);
  }
  inside(candidate: string): boolean {
    const rel = path.relative(this.root, candidate);
    return (
      rel === "" ||
      (!rel.startsWith(`..${path.sep}`) &&
        rel !== ".." &&
        !path.isAbsolute(rel))
    );
  }
  async resolve(relative: string, allowMissing = false): Promise<string> {
    if (
      typeof relative !== "string" ||
      relative.includes("\0") ||
      relative.includes("\\") ||
      path.isAbsolute(relative) ||
      relative.split("/").includes("..")
    )
      throw new RpcError(
        "PATH_DENIED",
        "Path must remain inside the workspace",
      );
    const full = path.resolve(this.root, relative || ".");
    if (
      !this.inside(full) ||
      (this.privateRoot &&
        (full === this.privateRoot ||
          full.startsWith(this.privateRoot + path.sep)))
    )
      throw new RpcError(
        "PATH_DENIED",
        "Path is outside the accessible workspace",
      );
    let cursor = full;
    while (true) {
      try {
        const real = await fs.realpath(cursor);
        if (
          !this.inside(real) ||
          (this.privateRoot &&
            (real === this.privateRoot ||
              real.startsWith(this.privateRoot + path.sep)))
        )
          throw new RpcError(
            "PATH_DENIED",
            "Symlink leaves the accessible workspace",
          );
        return path.join(real, path.relative(cursor, full));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          !allowMissing ||
          cursor === this.root
        )
          throw error;
        cursor = path.dirname(cursor);
      }
    }
  }
  async list(relative = ""): Promise<FileEntry[]> {
    const full = await this.resolve(relative);
    const entries = await fs.readdir(full, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name.startsWith(".oxbit-tmp-"))
        continue;
      const child = path.posix.join(relative, entry.name);
      try {
        const target = await this.resolve(child);
        const stat = await fs.stat(target);
        if (entry.isSymbolicLink() && stat.isDirectory()) {
          let ancestor = path.resolve(this.root, relative || "."), cycle = false;
          while (this.inside(ancestor)) { if (await fs.realpath(ancestor) === target) { cycle = true; break; } if (ancestor === this.root) break; ancestor = path.dirname(ancestor); }
          if (cycle) continue;
        }
        if (stat.isFile() || stat.isDirectory())
          result.push({
            path: child,
            name: entry.name,
            kind: stat.isDirectory() ? "directory" : "file",
            size: stat.size,
            readonly: await this.readonly(target),
          });
      } catch (error) {
        if (
          (error instanceof RpcError && error.code === "PATH_DENIED") ||
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
          continue;
        throw error;
      }
    }
    return result.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name)
        : a.kind === "directory"
          ? -1
          : 1,
    );
  }
  private async readonly(full: string) {
    try {
      await fs.access(full, constants.W_OK);
      return false;
    } catch {
      return true;
    }
  }
  async read(relative: string, encoding?: Encoding): Promise<FileSnapshot> {
    const full = await this.resolve(relative);
    const stat = await fs.stat(full);
    if (!stat.isFile())
      throw new RpcError("NOT_FILE", "Path is not a regular file");
    if (stat.size > 20 * 1024 * 1024)
      throw new RpcError(
        "FILE_TOO_LARGE",
        "Files above 20 MiB must be opened outside this editor",
      );
    const bytes = await fs.readFile(full);
    return {
      path: relative,
      ...decode(bytes, encoding),
      revision: revision(bytes),
      readonly: await this.readonly(full),
    };
  }
  async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
  async write(
    relative: string,
    text: string,
    options: WriteOptions,
  ): Promise<FileSnapshot> {
    const resolved = await this.resolve(relative, true);
    return this.locked(resolved, async () => {
      const full = await this.resolve(relative, true);
      if (full === this.root)
        throw new RpcError("PATH_DENIED", "Cannot overwrite workspace root");
      let current: Buffer | null = null;
      try {
        current = await fs.readFile(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const actual = current ? revision(current) : null;
      if (options.expectedRevision !== actual)
        throw new RpcError("CONFLICT", "File changed since it was read", {
          path: relative,
          expectedRevision: options.expectedRevision,
          actualRevision: actual,
        });
      const bytes = encode(text, options.encoding, options.eol);
      if (bytes.length > 20 * 1024 * 1024)
        throw new RpcError(
          "FILE_TOO_LARGE",
          "Files above 20 MiB are unsupported",
        );
      const temporary = path.join(
        path.dirname(full),
        `.oxbit-tmp-${randomUUID()}`,
      );
      let mode = 0o644;
      try {
        mode = (await fs.stat(full)).mode;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!(mode & 0o222)) throw new RpcError("READ_ONLY", "File is read-only");
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx", mode });
        await fs.rename(temporary, full);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return this.read(relative, options.encoding);
    });
  }
  async mkdir(relative: string) {
    const full = await this.resolve(relative, true);
    await fs.mkdir(full);
  }
  async rename(relative: string, to: string) {
    const from = await this.resolve(relative);
    const target = await this.resolve(to, true);
    if (from === this.root || target === this.root)
      throw new RpcError("PATH_DENIED", "Cannot rename workspace root");
    try {
      await fs.lstat(target);
      throw new RpcError("EXISTS", "Destination already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(path.resolve(this.root, relative), target);
  }
  async delete(relative: string) {
    const full = await this.resolve(relative);
    if (full === this.root)
      throw new RpcError("PATH_DENIED", "Cannot delete workspace root");
    await fs.rm(path.resolve(this.root, relative), { recursive: true });
  }
}
