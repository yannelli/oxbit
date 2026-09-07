import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { x as untar } from "tar";
import npmLock from "./npm/package-lock.json";
import nativeLock from "./artifacts.lock.json";

export type ManagedPlatform = "darwin-arm64" | "linux-x64";
type Package = { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
const packages = npmLock.packages as Record<string, Package>;
export function fingerprint(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function lockedPackages(roots: string[]) {
  const selected = new Map<string, Package>();
  function visit(location: string) {
    if (selected.has(location)) return;
    const entry = packages[location];
    if (!entry?.resolved || !entry.integrity || !entry.version) throw new Error(`Missing locked package: ${location}`);
    selected.set(location, entry);
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      let base = location, found: string | undefined;
      while (true) {
        const candidate = `${base ? base + "/" : ""}node_modules/${name}`;
        if (packages[candidate]) { found = candidate; break; }
        if (!base) break;
        base = base.includes("/node_modules/") ? base.slice(0, base.lastIndexOf("/node_modules/")) : "";
      }
      if (found) visit(found);
      else if (!entry.optionalDependencies?.[name]) throw new Error(`Unresolved locked dependency: ${name}`);
    }
  }
  roots.forEach(name => visit(`node_modules/${name}`));
  return selected;
}
export function verifyIntegrity(bytes: Uint8Array, integrity: string) {
  const [algorithm, expected] = integrity.split("-", 2);
  if (!["sha256", "sha512"].includes(algorithm) || !expected || createHash(algorithm).update(bytes).digest("base64") !== expected) throw new Error("Managed language server integrity check failed");
}

export class ManagedInstaller {
  constructor(readonly cache: string, readonly platform: ManagedPlatform = `${process.platform}-${process.arch}` as ManagedPlatform, private download: typeof fetch = fetch) {}
  private async bytes(url: string, integrity: string, signal?: AbortSignal) {
    if (!url.startsWith("https://")) throw new Error("Managed artifacts require HTTPS");
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const response = await this.download(url, { signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]) });
        if (!response.ok || !response.body) throw new Error(`Artifact download failed (${response.status})`);
        const chunks: Uint8Array[] = []; let size = 0;
        for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > 256 * 1024 * 1024) throw new Error("Managed artifact exceeds 256 MiB");
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        verifyIntegrity(bytes, integrity); return bytes;
      } catch (error) { failure = error; signal?.throwIfAborted(); }
      if (attempt < 2) await delay(250 * 2 ** attempt, undefined, { signal });
    }
    throw failure;
  }
  private async extract(bytes: Buffer, directory: string, strip: number) {
    await fs.mkdir(directory, { recursive: true });
    const archive = directory + ".tgz";
    await fs.writeFile(archive, bytes);
    try {
      await untar({ file: archive, cwd: directory, strip, strict: true, preservePaths: false,
        filter(name, candidate) {
          const entry = candidate as import("tar").ReadEntry;
          const normalized = name.split("/").slice(strip).join("/");
          if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) throw new Error("Unsafe archive path");
          if (!["File", "OldFile", "Directory", "SymbolicLink"].includes(entry.type)) throw new Error("Unsupported archive entry");
          if (entry.type === "SymbolicLink") {
            const target = path.resolve(directory, path.dirname(normalized), entry.linkpath ?? "");
            if (path.isAbsolute(entry.linkpath ?? "") || !target.startsWith(directory + path.sep)) throw new Error("Archive link leaves installation");
          }
          return true;
        },
      });
    } finally { await fs.rm(archive, { force: true }); }
  }
  private async install(id: string, digest: string, build: (stage: string) => Promise<void>, signal?: AbortSignal) {
    if (!["darwin-arm64", "linux-x64"].includes(this.platform)) throw new Error(`Managed language servers are unavailable on ${this.platform}`);
    const base = path.join(this.cache, `${id}-${this.platform}`), target = path.join(base, digest);
    const complete = async () => { try { return (await fs.readFile(path.join(target, ".complete"), "utf8")) === digest; } catch { return false; } };
    if (await complete()) return target;
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    const lock = path.join(base, ".install-lock");
    const deadline = Date.now() + 180_000;
    while (true) {
      signal?.throwIfAborted();
      try { await fs.mkdir(lock); await fs.writeFile(path.join(lock, "owner"), String(process.pid)); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await complete()) return target;
        try {
          const pid = Number(await fs.readFile(path.join(lock, "owner"), "utf8"));
          if (pid > 0) { try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { await fs.rm(lock, { recursive: true, force: true }); continue; } } }
        } catch {
          // Recover a host crash between creating the lock and writing its owner.
          try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 60_000) { await fs.rm(lock, { recursive: true, force: true }); continue; } } catch { /* Another waiter recovered it. */ }
        }
        if (Date.now() > deadline) throw new Error("Timed out waiting for another language server installation");
        await delay(100, undefined, { signal });
      }
    }
    const stage = path.join(base, `.staging-${randomUUID()}`);
    try {
      if (await complete()) return target;
      for (const name of await fs.readdir(base)) if (name.startsWith(".staging-")) await fs.rm(path.join(base, name), { recursive: true, force: true });
      await fs.mkdir(stage, { mode: 0o700 });
      await build(stage); signal?.throwIfAborted();
      await fs.writeFile(path.join(stage, ".complete"), digest);
      // Replace an interrupted installation only after its replacement is ready.
      // Previous working digests and damaged trees remain available for recovery.
      try { await fs.rename(target, path.join(base, `.damaged-${digest}-${randomUUID()}`)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await fs.rename(stage, target);
      return target;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
      await fs.rm(lock, { recursive: true, force: true });
    }
  }
  async npm(id: string, roots: string[], signal?: AbortSignal) {
    const entries = lockedPackages(roots), digest = fingerprint([...entries]);
    const directory = await this.install(id, digest, async stage => {
      // Fetch a bounded number at once, then extract in depth order so parent packages cannot overwrite dependencies.
      const queue = [...entries].sort(([a], [b]) => a.split("/").length - b.split("/").length);
      for (let start = 0; start < queue.length; start += 6) {
        const batch = queue.slice(start, start + 6);
        const bytes = await Promise.all(batch.map(([, entry]) => this.bytes(entry.resolved!, entry.integrity!, signal)));
        for (const [index, [location]] of batch.entries()) {
          signal?.throwIfAborted();
          await this.extract(bytes[index], path.join(stage, location), 1);
        }
      }
      await fs.writeFile(path.join(stage, "installation.json"), JSON.stringify({ id, digest, packages: Object.fromEntries(entries) }, null, 2));
    }, signal);
    return { directory, version: packages[`node_modules/${roots[0]}`].version!, integrity: digest };
  }
  async native(id: string, signal?: AbortSignal) {
    const artifact = nativeLock.artifacts.find(item => item.id === id && item.platform === this.platform);
    if (!artifact) throw new Error(`No pinned ${id} artifact for ${this.platform}`);
    const digest = fingerprint(artifact);
    const directory = await this.install(id, digest, async stage => {
      const bytes = await this.bytes(artifact.url, artifact.integrity, signal);
      if (artifact.format === "tar") await this.extract(bytes, stage, 0);
      else await fs.writeFile(path.join(stage, artifact.entry), artifact.format === "gzip" ? gunzipSync(bytes) : bytes);
      await fs.chmod(path.join(stage, artifact.entry), 0o755);
      await fs.writeFile(path.join(stage, "installation.json"), JSON.stringify(artifact, null, 2));
    }, signal);
    return { directory, executable: path.join(directory, artifact.entry), version: artifact.version, integrity: artifact.integrity };
  }
}
