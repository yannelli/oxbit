import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { ACP_REGISTRY_URL, acpBuiltinForRegistry, type ACPRegistryAgent, type ACPRegistryDistribution, type ACPRegistryListing } from "@oxbit/sdk";
import { RpcError } from "@oxbit/protocol";

const run = promisify(execFile);
const TTL = 300_000, MiB = 1024 * 1024, MAX_LISTING = 2 * MiB, MAX_ARCHIVE = 512 * MiB;
export const REGISTRY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TARGETS = ["darwin", "linux", "windows"].flatMap((os) => [`${os}-aarch64`, `${os}-x86_64`]);
const ARCHIVES = [".tar.gz", ".tgz", ".tar.bz2", ".tar.xz", ".zip"];

export type RegistryPackage = { package: string; args: string[]; env: Record<string, string> };
export type RegistryBinary = { archive: string; cmd: string; args: string[]; env: Record<string, string>; sha256?: string };
export interface RegistryEntry {
  id: string; name: string; version: string; description: string;
  repository?: string; website?: string; license?: string;
  distribution: { npx?: RegistryPackage; uvx?: RegistryPackage; binary?: Record<string, RegistryBinary> };
}
export type Picked =
  | { kind: "npx" | "uvx"; spec: RegistryPackage }
  | { kind: "binary"; spec: RegistryBinary };
export interface ResolvedAgent { name: string; command: string; args: string[]; env: Record<string, string> }

const invalid = (): never => { throw new Error("invalid"); };
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number) =>
  typeof value === "string" && value && value.length <= max && !value.includes("\0") ? value : invalid();
const optional = (value: unknown, max: number) => (value === undefined ? undefined : str(value, max));
const list = (value: unknown) =>
  value === undefined ? [] : Array.isArray(value) && value.length <= 128 && value.every((v) => typeof v === "string" && v.length <= 16384 && !v.includes("\0")) ? (value as string[]) : invalid();
function env(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!plain(value)) return invalid();
  const entries = Object.entries(value);
  if (entries.length > 64 || entries.some(([k, v]) => !ENV_KEY.test(k) || typeof v !== "string" || v.length > 16384 || v.includes("\0"))) return invalid();
  return Object.fromEntries(entries) as Record<string, string>;
}
function url(value: unknown) {
  const parsed = new URL(str(value, 4096));
  return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : invalid();
}
function pkg(value: unknown): RegistryPackage | undefined {
  if (value === undefined) return;
  if (!plain(value)) return invalid();
  const name = str(value.package, 512);
  if (name.startsWith("-")) return invalid();
  return { package: name, args: list(value.args), env: env(value.env) };
}
function binary(value: unknown): Record<string, RegistryBinary> | undefined {
  if (value === undefined) return;
  if (!plain(value)) return invalid();
  const targets: Record<string, RegistryBinary> = {};
  for (const [key, t] of Object.entries(value)) {
    if (!plain(t)) return invalid();
    const sha256 = t.sha256 === undefined ? undefined : typeof t.sha256 === "string" && /^[a-f0-9]{64}$/i.test(t.sha256) ? t.sha256.toLowerCase() : invalid();
    const target = { archive: url(t.archive), cmd: str(t.cmd, 1024), args: list(t.args), env: env(t.env), sha256 };
    // Targets outside the six documented platforms are ignored so a new platform does not hide an agent.
    if (TARGETS.includes(key)) targets[key] = target;
  }
  return targets;
}
function entry(value: unknown): RegistryEntry {
  if (!plain(value) || !plain(value.distribution)) return invalid();
  const id = str(value.id, 64), version = str(value.version, 64);
  if (!REGISTRY_ID.test(id) || !VERSION.test(version)) return invalid();
  if (typeof value.description !== "string" || value.description.length > 4000) return invalid();
  const d = value.distribution;
  const distribution = { npx: pkg(d.npx), uvx: pkg(d.uvx), binary: binary(d.binary) };
  if (!distribution.npx && !distribution.uvx && !distribution.binary) return invalid();
  return {
    id, version, name: str(value.name, 200), description: value.description,
    repository: optional(value.repository, 2048), website: optional(value.website, 2048), license: optional(value.license, 200),
    distribution,
  };
}
/** Returns the valid entries of a registry document; invalid entries are dropped. */
export function parseRegistry(text: string): RegistryEntry[] {
  const value: unknown = JSON.parse(text);
  if (!plain(value) || !Array.isArray(value.agents)) throw new Error("The ACP Registry response has no agents list");
  const agents = new Map<string, RegistryEntry>();
  for (const item of value.agents.slice(0, 2000)) {
    try {
      const agent = entry(item);
      if (!agents.has(agent.id)) agents.set(agent.id, agent);
    } catch { /* Invalid entries are not listed. */ }
  }
  return [...agents.values()];
}
export function platformTarget(platform: string = process.platform, arch: string = process.arch) {
  const os = ({ darwin: "darwin", linux: "linux", win32: "windows" } as Record<string, string>)[platform];
  const cpu = ({ arm64: "aarch64", x64: "x86_64" } as Record<string, string>)[arch];
  return os && cpu ? `${os}-${cpu}` : undefined;
}
export function pickDistribution(agent: RegistryEntry, target = platformTarget()): Picked | undefined {
  const { npx, uvx, binary } = agent.distribution;
  if (npx) return { kind: "npx", spec: npx };
  if (uvx) return { kind: "uvx", spec: uvx };
  const spec = target ? binary?.[target] : undefined;
  if (spec) return { kind: "binary", spec };
}
async function* capped(body: AsyncIterable<Uint8Array>, max: number, what: string) {
  let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > max) throw new Error(`${what} exceeds ${max / MiB} MiB`);
    yield chunk;
  }
}
const exists = (file: string) => fs.stat(file).then(() => true, () => false);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Resolves the agent command inside `dir`, rejecting paths and symlinks that leave it, and marks it executable. */
export async function installedCommand(dir: string, cmd: string) {
  const root = await fs.realpath(dir);
  const inside = (file: string) => file.startsWith(root + path.sep);
  const escape = new RpcError("INVALID_PARAMS", `The agent command ${cmd} resolves outside its install directory`);
  const target = path.resolve(root, cmd);
  if (!inside(target)) throw escape;
  const real = await fs.realpath(target).catch(() => {
    throw new RpcError("INVALID_PARAMS", `The agent archive has no ${cmd}`);
  });
  if (!inside(real)) throw escape;
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new RpcError("INVALID_PARAMS", `The agent command ${cmd} is not a file`);
  if (process.platform !== "win32") await fs.chmod(real, stat.mode | 0o111);
  return real;
}
async function extract(archive: string, dest: string, format: string, signal?: AbortSignal) {
  const tar: [string, string[]] = ["tar", ["-xf", archive, "-C", dest]];
  const attempts = format !== ".zip" ? [tar] : [...(process.platform === "darwin" ? [tar] : []), ["unzip", ["-q", archive, "-d", dest]] as [string, string[]]];
  const missing: string[] = [];
  let failure: unknown;
  for (const [tool, args] of attempts) {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(dest);
    try {
      await run(tool, args, { signal, maxBuffer: MiB });
      return;
    } catch (error) {
      if (signal?.aborted) throw new Error("Agent connection cancelled");
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(tool);
      else failure = new Error(`${tool} could not extract the agent archive: ${String((error as { stderr?: string }).stderr || message(error)).trim().slice(0, 500)}`);
    }
  }
  throw failure ?? new RpcError("INVALID_PARAMS", `Install ${missing.join(" or ")} to extract this agent archive`);
}

/** The runtime's copy of the ACP Registry. Nothing is downloaded until a listing or a registry launch needs it. */
export class ACPRegistry {
  private fetching?: Promise<{ agents: RegistryEntry[]; fetchedAt: string }>;
  private installs = new Map<string, Promise<string>>();
  readonly installRoot: string;
  constructor(
    private dataDir: string,
    readonly url: string = ACP_REGISTRY_URL,
    private download: typeof fetch = fetch,
    private target = platformTarget(),
  ) {
    this.installRoot = path.join(dataDir, "acp-agents");
  }
  private get cacheFile() { return path.join(this.dataDir, "acp-registry.json"); }
  private checkUrl(value: string) {
    const parsed = new URL(value), registry = new URL(this.url);
    const loopback = (u: URL) => u.protocol === "http:" && u.hostname === "127.0.0.1";
    if (parsed.protocol === "https:" || (loopback(registry) && loopback(parsed))) return parsed.href;
    throw new Error(`ACP agent downloads require HTTPS (${parsed.origin})`);
  }
  private async open(source: string, signal: AbortSignal, max: number, what: string) {
    let current = this.checkUrl(source);
    for (let redirects = 0; ; redirects++) {
      const response = await this.download(current, { signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error(`${what} redirect has no location`);
        if (redirects >= 5) throw new Error(`${what} has too many redirects`);
        current = this.checkUrl(new URL(location, current).href);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`${what} download failed (HTTP ${response.status})`);
      }
      if (Number(response.headers.get("content-length")) > max) {
        await response.body.cancel();
        throw new Error(`${what} exceeds ${max / MiB} MiB`);
      }
      return capped(response.body as unknown as AsyncIterable<Uint8Array>, max, what);
    }
  }
  private async cached() {
    try {
      const value = JSON.parse(await fs.readFile(this.cacheFile, "utf8"));
      if (value?.url === this.url && typeof value.text === "string" && !Number.isNaN(Date.parse(value.fetchedAt)))
        return { agents: parseRegistry(value.text), fetchedAt: value.fetchedAt as string };
    } catch { /* A missing or damaged cache is fetched again. */ }
  }
  private async fetchRegistry() {
    const chunks: Uint8Array[] = [];
    for await (const chunk of await this.open(this.url, AbortSignal.timeout(15_000), MAX_LISTING, "The ACP Registry")) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const agents = parseRegistry(text), fetchedAt = new Date().toISOString();
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temp = `${this.cacheFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ url: this.url, fetchedAt, text }), { mode: 0o600 });
    await fs.rename(temp, this.cacheFile);
    return { agents, fetchedAt };
  }
  async load(refresh = false): Promise<{ agents: RegistryEntry[]; fetchedAt: string; error?: string }> {
    const cached = await this.cached();
    const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
    if (cached && !refresh && age >= 0 && age < TTL) return cached;
    try {
      this.fetching ??= this.fetchRegistry().finally(() => (this.fetching = undefined));
      return await this.fetching;
    } catch (error) {
      const reason = `Could not reach the ACP Registry: ${message(error)}`;
      if (cached) return { ...cached, error: reason };
      throw new RpcError("UNAVAILABLE", reason);
    }
  }
  private dir(agent: RegistryEntry) { return path.join(this.installRoot, agent.id, agent.version); }
  private unavailable(picked: Picked | undefined) {
    if (!picked) return "No build for this runtime's platform";
    if (picked.kind !== "binary") return undefined;
    if (!picked.spec.sha256) return "The registry publishes no checksum for this build";
    const file = new URL(picked.spec.archive).pathname.toLowerCase();
    if (!ARCHIVES.some((ext) => file.endsWith(ext))) return "Oxbit cannot extract this build's archive format";
  }
  async listing(refresh = false): Promise<ACPRegistryListing> {
    const { agents, fetchedAt, error } = await this.load(refresh);
    const listed = await Promise.all(agents.map(async (agent): Promise<ACPRegistryAgent> => {
      const picked = pickDistribution(agent, this.target), builtin = acpBuiltinForRegistry(agent.id)?.id;
      const { npx, uvx } = agent.distribution;
      const distribution: ACPRegistryDistribution = picked?.kind ?? (npx ? "npx" : uvx ? "uvx" : "binary");
      const reason = this.unavailable(picked);
      return {
        id: agent.id, name: agent.name, version: agent.version, description: agent.description,
        ...(agent.repository ? { repository: agent.repository } : {}),
        ...(agent.website ? { website: agent.website } : {}),
        ...(agent.license ? { license: agent.license } : {}),
        distribution, available: !reason,
        ...(reason ? { reason } : {}),
        ...(picked?.kind === "binary" ? { installed: await exists(this.dir(agent)) } : {}),
        ...(builtin ? { builtin } : {}),
      };
    }));
    return { agents: listed, fetchedAt, ...(error ? { error } : {}) };
  }
  async resolve(id: string, version?: string, signal?: AbortSignal): Promise<ResolvedAgent> {
    const agent = (await this.load()).agents.find((a) => a.id === id);
    if (!agent) throw new RpcError("INVALID_PARAMS", "Unknown agent");
    if (version !== undefined && version !== agent.version)
      throw new RpcError("INVALID_PARAMS", `${agent.name} ${version} is no longer in the ACP Registry; refresh the agent list`);
    const picked = pickDistribution(agent, this.target);
    if (!picked) throw new RpcError("INVALID_PARAMS", `${agent.name} has no ACP Registry build for ${this.target ?? `${process.platform}-${process.arch}`}`);
    const base = { name: agent.name, env: picked.spec.env };
    if (picked.kind !== "binary") {
      const { package: name, args } = picked.spec;
      return { ...base, command: picked.kind, args: picked.kind === "npx" ? ["-y", name, ...args] : [name, ...args] };
    }
    return { ...base, command: await this.install(agent, picked.spec, signal), args: picked.spec.args };
  }
  install(agent: RegistryEntry, spec: RegistryBinary, signal?: AbortSignal) {
    const key = `${agent.id}@${agent.version}`;
    let pending = this.installs.get(key);
    if (!pending) {
      pending = this.installOnce(agent, spec, signal).finally(() => this.installs.delete(key));
      this.installs.set(key, pending);
    }
    return pending;
  }
  private async installOnce(agent: RegistryEntry, spec: RegistryBinary, signal?: AbortSignal) {
    const dir = this.dir(agent);
    if (await exists(dir)) return installedCommand(dir, spec.cmd);
    if (!spec.sha256) throw new RpcError("INVALID_PARAMS", `${agent.name} has no sha256 checksum in the ACP Registry, so Oxbit does not install it`);
    const file = new URL(spec.archive).pathname.toLowerCase();
    const format = ARCHIVES.find((ext) => file.endsWith(ext));
    if (!format) throw new RpcError("INVALID_PARAMS", `Oxbit cannot extract ${path.posix.basename(file)}; supported archives are ${ARCHIVES.join(", ")}`);
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    const temp = await fs.mkdtemp(path.join(path.dirname(dir), `.${agent.version}-`));
    try {
      const archive = path.join(temp, `archive${format}`), files = path.join(temp, "files");
      const hash = createHash("sha256");
      const body = await this.open(spec.archive, signal ?? new AbortController().signal, MAX_ARCHIVE, `The ${agent.name} archive`);
      await pipeline(async function* () {
        for await (const chunk of body) { hash.update(chunk); yield chunk; }
      }, createWriteStream(archive, { mode: 0o600 }), signal ? { signal } : {});
      if (hash.digest("hex") !== spec.sha256)
        throw new RpcError("INVALID_PARAMS", `The ${agent.name} archive does not match its sha256 checksum`);
      await extract(archive, files, format, signal);
      await installedCommand(files, spec.cmd);
      await fs.rename(files, dir).catch(async (error) => {
        if (!(await exists(dir))) throw error;
      });
      return await installedCommand(dir, spec.cmd);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}
