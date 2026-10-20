import * as fs from "node:fs/promises";
import path from "node:path";
import { ControlError } from "@oxbit/sdk/tunnel";

/** Relative to the home folder; refused by `host.list` and `host.open` together with everything below them. */
export const HIDDEN_PATHS = [".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config/gcloud", "Library/Keychains", ".oxbit"];
export const MAX_ENTRIES = 2000;

export interface Entry {
  name: string;
  kind: "directory" | "file";
}
export interface Listing {
  path: string;
  parent?: string;
  entries: Entry[];
  truncated?: true;
}

const within = (base: string, target: string) => target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

/** Home-folder policy for device paths. Symlinks are resolved before every check. */
export class PathPolicy {
  private constructor(
    private readonly lexicalHome: string,
    readonly home: string,
  ) {}

  static async create(home: string): Promise<PathPolicy> {
    const lexical = path.resolve(home);
    return new PathPolicy(lexical, await fs.realpath(lexical));
  }

  /** Lexical and resolved forms of each hidden path, read at each call so later symlinks count. */
  async hidden(): Promise<string[]> {
    const lexical = HIDDEN_PATHS.flatMap((entry) => [path.join(this.lexicalHome, entry), path.join(this.home, entry)]);
    const resolved = await Promise.all(lexical.map((entry) => fs.realpath(entry).catch(() => undefined)));
    return [...new Set([...lexical, ...resolved.filter((entry): entry is string => entry !== undefined)])];
  }

  allowed(real: string, hidden: string[]): boolean {
    return within(this.home, real) && !hidden.some((entry) => within(entry, real));
  }

  /** Returns the real path for `input` (absolute, `~/sub/dir`, or relative to home) or throws a ControlError. */
  async resolve(input: unknown): Promise<string> {
    if (input !== undefined && input !== null && typeof input !== "string") throw new ControlError("INVALID_PARAMS", "path must be a string");
    const raw = (input ?? "").trim() || "~";
    const expanded = raw === "~" ? this.home : raw.startsWith("~/") ? path.join(this.home, raw.slice(2)) : raw;
    const lexical = path.resolve(this.home, expanded);
    const hidden = await this.hidden();
    if (hidden.some((entry) => within(entry, lexical))) throw new ControlError("FORBIDDEN", "This folder is hidden from remote access");
    let real: string;
    try {
      real = await fs.realpath(lexical);
    } catch {
      throw new ControlError("NOT_FOUND", `No such file or folder: ${lexical}`);
    }
    if (!within(this.home, real)) throw new ControlError("FORBIDDEN", "Remote access is limited to the home folder");
    if (!this.allowed(real, hidden)) throw new ControlError("FORBIDDEN", "This folder is hidden from remote access");
    return real;
  }

  /** `resolve`, then requires a directory. */
  async directory(input: unknown): Promise<string> {
    const real = await this.resolve(input);
    if (!(await fs.stat(real)).isDirectory()) throw new ControlError("NOT_A_DIRECTORY", `${real} is not a folder`);
    return real;
  }
}

type PolicyCheck = { allowed(real: string): boolean };

async function entryKind(policy: PolicyCheck, full: string, dirent: { isDirectory(): boolean; isSymbolicLink(): boolean }) {
  if (dirent.isDirectory()) return "directory";
  if (!dirent.isSymbolicLink()) return "file";
  try {
    const real = await fs.realpath(full);
    if (!policy.allowed(real)) return undefined;
    return (await fs.stat(real)).isDirectory() ? "directory" : "file";
  } catch {
    return undefined;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** `host.list`: directories first, dot entries and hidden paths left out, at most MAX_ENTRIES. */
export async function listDirectory(policy: PathPolicy, input: unknown, limit = MAX_ENTRIES): Promise<Listing> {
  const real = await policy.directory(input);
  const hidden = await policy.hidden();
  const check: PolicyCheck = { allowed: (target) => policy.allowed(target, hidden) };
  const dirents = (await fs.readdir(real, { withFileTypes: true })).filter(
    (dirent) => !dirent.name.startsWith(".") && check.allowed(path.join(real, dirent.name)),
  );
  const kinds = await Promise.all(dirents.map((dirent) => entryKind(check, path.join(real, dirent.name), dirent)));
  const entries = dirents
    .map((dirent, index) => ({ name: dirent.name, kind: kinds[index] }))
    .filter((entry): entry is Entry => entry.kind !== undefined)
    .sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "directory" ? -1 : 1));
  return {
    path: real,
    ...(real === policy.home ? {} : { parent: path.dirname(real) }),
    entries: entries.slice(0, limit),
    ...(entries.length > limit ? { truncated: true as const } : {}),
  };
}
