import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcError } from "@oxbit/protocol";
import type { ExternalDocument } from "@oxbit/sdk";
const contains = (root: string, file: string) => file.startsWith(root + path.sep);
/** Roots come only from trusted preset resolution, never from LSP responses/settings. */
export class ExternalSources {
  private roots: string[] = [];
  private handles = new Map<string, { file: string; uri: string }>();
  async register(roots: string[]) {
    this.clear();
    for (const root of roots) {
      const real = await fs.realpath(root);
      if (real === path.parse(real).root || !path.isAbsolute(real)) throw new RpcError("PATH_DENIED", "Invalid dependency root");
      if ((await fs.stat(real)).isDirectory()) this.roots.push(real);
    }
  }
  async authorize(uri: string): Promise<{ handle: string; uri: string; name: string; readonly: true }> {
    const url = new URL(uri);
    if (url.protocol !== "file:" || url.host || url.search || url.hash) throw new RpcError("PATH_DENIED", "External sources require local file URIs");
    const file = await fs.realpath(fileURLToPath(url));
    if (!this.roots.some(root => contains(root, file))) throw new RpcError("PATH_DENIED", "Source is outside registered dependency roots");
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new RpcError("PATH_DENIED", "Source is not a supported text file");
    const handle = randomUUID();
    if (this.handles.size >= 512) this.handles.delete(this.handles.keys().next().value!);
    this.handles.set(handle, { file, uri });
    return { handle, uri, name: path.basename(file), readonly: true };
  }
  async read(handle: string): Promise<ExternalDocument> {
    const entry = this.handles.get(handle);
    if (!entry || !this.roots.some(root => contains(root, entry.file)) || await fs.realpath(entry.file) !== entry.file) throw new RpcError("PATH_DENIED", "External source handle expired");
    const descriptor = await fs.open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await descriptor.stat();
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new RpcError("PATH_DENIED", "External source is not a supported text file");
      const bytes = await descriptor.readFile();
      const current = await fs.stat(entry.file);
      if (stat.dev !== current.dev || stat.ino !== current.ino || bytes.length > 20 * 1024 * 1024 || await fs.realpath(entry.file) !== entry.file || bytes.includes(0)) throw new RpcError("PATH_DENIED", "External source changed or is binary");
      return { handle, uri: entry.uri, name: path.basename(entry.file), text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), revision: createHash("sha256").update(bytes).digest("hex"), readonly: true };
    } finally { await descriptor.close(); }
  }
  clear() { this.roots = []; this.handles.clear(); }
}
