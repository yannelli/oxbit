import type { ContextProvider, SessionView } from "./extensions.js";

/** Read access to the host's local files. Paths are absolute and use `/`. */
export interface HostFiles {
  /** Entries of a directory, with `kind` after following symlinks. Resolves to [] when the directory is missing. */
  list(path: string): Promise<{ name: string; kind: "file" | "directory" }[]>;
  /** UTF-8 text of a file. Rejects when the file is missing or unreadable. */
  read(path: string): Promise<string>;
  /** True for an existing file or directory. */
  exists(path: string): Promise<boolean>;
}

export interface InstructionOptions {
  files: HostFiles;
  /** Absolute path of the global AGENTS.md, for example ~/.oxbit/agent/AGENTS.md. */
  global?: string;
  /** Absolute path of ~/.claude/CLAUDE.md. Pass it only when the setting that enables it is on. */
  claude?: string;
  /** System prompt text from settings, added after the instruction files. */
  append?: string;
  /** Called on each system prompt; true leaves the file out. */
  skip?(path: string): boolean;
}
/** A file that Instructions reads; `text` is undefined for a global file that is missing or empty. */
export interface InstructionFile { path: string; scope: "global" | "claude" | "project"; text?: string }

export const FILE_LIMIT = 32 * 1024;
export const TOTAL_LIMIT = 64 * 1024;
const NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
const encoder = new TextEncoder();

export const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;
export const parentPath = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
export const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `from`, then its parents up to `to`. Only `from` when `to` is not an ancestor of it. */
export function ancestors(from: string, to: string) {
  const dirs = [from];
  if (to === from || !from.startsWith(to === "/" ? "/" : `${to}/`)) return dirs;
  for (let dir = from; dir !== to;) dirs.push(dir = parentPath(dir));
  return dirs;
}

/** The nearest directory at or above `cwd` that has a `.git` file or directory. */
export async function findGitRoot(files: HostFiles, cwd: string) {
  for (let dir = cwd; ; dir = parentPath(dir)) {
    if (await files.exists(joinPath(dir, ".git"))) return dir;
    if (dir === "/") return undefined;
  }
}

const readText = async (files: HostFiles, path: string) => {
  try {
    const text = await files.read(path);
    return text.trim() ? { path, text } : undefined;
  } catch {
    return undefined;
  }
};
const firstOf = async (files: HostFiles, dir: string) => {
  for (const name of NAMES) {
    const file = await readText(files, joinPath(dir, name));
    if (file) return file;
  }
  return undefined;
};
const clipBytes = (text: string, limit: number) => {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return { text, size: bytes.length, clipped: false };
  return { text: new TextDecoder().decode(bytes.slice(0, limit)).replace(/�+$/, ""), size: limit, clipped: true };
};

/** System prompt section from AGENTS.md and CLAUDE.md files, each labeled with its path. */
export class Instructions implements ContextProvider {
  constructor(private options: InstructionOptions) {}
  /** The global and Claude files whether or not they exist, then the project files that load, without repeated paths. */
  async candidates(cwd: string): Promise<InstructionFile[]> {
    const { files, global, claude } = this.options;
    const dirs = ancestors(cwd, (await findGitRoot(files, cwd)) ?? cwd).reverse();
    const own = async (path: string | undefined, scope: "global" | "claude") => path ? { path, scope, text: (await readText(files, path))?.text } : undefined;
    const found: (InstructionFile | undefined)[] = [...await Promise.all([own(global, "global"), own(claude, "claude")]),
      ...(await Promise.all(dirs.map((dir) => firstOf(files, dir)))).map((file) => file && { ...file, scope: "project" as const })];
    return found.filter((file, index): file is InstructionFile => !!file && found.findIndex((other) => other?.path === file.path) === index);
  }
  /** Global files, then from the git root (or cwd) down to cwd the first non-empty AGENTS.override.md, AGENTS.md or CLAUDE.md. */
  async load(cwd: string) {
    return (await this.candidates(cwd)).flatMap(({ path, text }) => text === undefined ? [] : [{ path, text }]);
  }
  async system(session: SessionView) {
    const sections: string[] = [];
    let used = 0;
    let skipped = 0;
    for (const file of await this.load(session.cwd)) {
      if (this.options.skip?.(file.path)) continue;
      const room = Math.min(FILE_LIMIT, TOTAL_LIMIT - used);
      if (room <= 0) {
        skipped++;
        continue;
      }
      const clipped = clipBytes(file.text.trim(), room);
      used += clipped.size;
      sections.push(`<instructions path="${escapeXml(file.path)}">\n${clipped.text}${clipped.clipped ? `\n[Truncated at ${room} bytes]` : ""}\n</instructions>`);
    }
    if (skipped) sections.push(`[Skipped ${skipped} more instruction files: the ${TOTAL_LIMIT / 1024} KiB limit is reached]`);
    const append = this.options.append?.trim();
    if (!sections.length && !append) return undefined;
    const intro = sections.length ? "Instructions from AGENTS.md and CLAUDE.md files. Later files are closer to the working directory and take precedence." : "";
    return [intro, ...sections, append].filter((part) => !!part).join("\n\n");
  }
}
