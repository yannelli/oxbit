import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileEntry, FileSnapshot, FileSystem, WorkspaceSearchMatch, WorkspaceSearchOptions, WorkspaceSearchResult } from "@oxbit/sdk";
import { resolvePath } from "@oxbit/agent-core";
import { IgnoreRules, globFilter, splitGlobs } from "./ignore.js";

const MAX_MATCHES = 2000;
const MAX_FILES = 50000;
const MAX_SEARCH_FILE = 2 * 1024 * 1024;
const SKIPPED = new Set([".git", "node_modules"]);

let ripgrep: Promise<boolean> | undefined;
/** Whether `rg` runs from PATH. Checked once per process. */
export const hasRipgrep = () => ripgrep ??= new Promise<boolean>((resolve) => {
  const child = spawn("rg", ["--version"], { stdio: "ignore" });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});

interface Run { code: number; stdout: string; stderr: string }
function run(command: string, args: string[], cwd: string, signal?: AbortSignal, maxBytes = 64 * 1024 * 1024): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      stdout += data;
      if (stdout.length > maxBytes) child.kill();
    });
    child.stderr.setEncoding("utf8").on("data", (data: string) => void (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Files under `root` that git would not ignore, skipping .git and node_modules. Directories end the walk at MAX_FILES. */
export async function walkFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relative: string, rules: IgnoreRules): Promise<void> => {
    if (signal?.aborted) throw new Error("Cancelled");
    const absolute = relative ? join(root, relative) : root;
    const gitignore = await readFile(join(absolute, ".gitignore"), "utf8").catch(() => undefined);
    const scoped = gitignore === undefined ? rules : rules.with(gitignore, relative);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const directory = entry.isDirectory();
      if (SKIPPED.has(entry.name) || scoped.ignores(path, directory)) continue;
      if (directory) await visit(path, scoped);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit("", new IgnoreRules());
  return files;
}

const fuzzy = (term: string) => (path: string) => {
  let at = 0;
  for (const char of term) {
    at = path.indexOf(char, at) + 1;
    if (!at) return false;
  }
  return true;
};
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function ripgrepSearch(root: string, options: WorkspaceSearchOptions, signal?: AbortSignal): Promise<WorkspaceSearchResult> {
  const args = ["--json", "--line-number", "--column", "--max-count", "1000", "--max-filesize", "20M", "--glob", "!.git/**", "--glob", "!node_modules/**"];
  if (!options.regex) args.push("--fixed-strings");
  if (!options.caseSensitive) args.push("--ignore-case");
  if (options.wholeWord) args.push("--word-regexp");
  for (const [list, exclude] of [[options.include, false], [options.exclude, true]] as const)
    for (const glob of splitGlobs(list)) args.push("--glob", exclude ? `!${glob}` : glob);
  args.push("--", options.query, ".");
  const result = await run("rg", args, root, signal);
  if (result.code > 1) throw new Error(result.stderr.trim() || "Search failed");
  const matches: WorkspaceSearchMatch[] = [];
  for (const row of result.stdout.split("\n")) {
    if (!row || matches.length >= MAX_MATCHES) continue;
    const parsed = JSON.parse(row);
    if (parsed.type !== "match") continue;
    const data = parsed.data;
    const raw = Buffer.from(String(data.lines.text ?? ""));
    const text = raw.toString().replace(/\r?\n$/, "");
    for (const sub of data.submatches ?? []) {
      const from = raw.subarray(0, sub.start).toString().length;
      matches.push({ path: String(data.path.text).replace(/^\.\//, ""), line: data.line_number, column: from + 1, from,
        to: raw.subarray(0, sub.end).toString().length, text, revision: "" });
    }
  }
  return { matches: matches.slice(0, MAX_MATCHES), truncated: matches.length >= MAX_MATCHES };
}

async function walkSearch(root: string, options: WorkspaceSearchOptions, signal?: AbortSignal): Promise<WorkspaceSearchResult> {
  const source = options.regex ? options.query : escapeRegExp(options.query);
  const pattern = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? "g" : "gi");
  const include = globFilter(options.include);
  const exclude = globFilter(options.exclude);
  const matches: WorkspaceSearchMatch[] = [];
  for (const path of await walkFiles(root, signal)) {
    if ((include && !include(path)) || exclude?.(path)) continue;
    const info = await stat(join(root, path)).catch(() => undefined);
    if (!info || info.size > MAX_SEARCH_FILE) continue;
    const text = await readFile(join(root, path), "utf8").catch(() => "");
    if (text.includes("\0")) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        if (matches.length > MAX_MATCHES || !match[0]) break;
        matches.push({ path, line: index + 1, column: match.index + 1, from: match.index, to: match.index + match[0].length, text: line, revision: "" });
      }
    });
    if (matches.length > MAX_MATCHES) break;
  }
  return { matches: matches.slice(0, MAX_MATCHES), truncated: matches.length > MAX_MATCHES };
}

const snapshot = (path: string, text: string, revision: string): FileSnapshot =>
  ({ path, text, revision, encoding: "utf-8", eol: text.includes("\r\n") ? "CRLF" : "LF" });

/** SDK FileSystem over node:fs for `root`. Search uses rg from PATH, else a walk that honors .gitignore. */
export function nodeFilesystem(root: string, options: { ripgrep?: boolean } = {}): FileSystem {
  const absolute = (path = "") => resolvePath(root, path).absolute;
  const useRipgrep = () => options.ripgrep === false ? Promise.resolve(false) : hasRipgrep();
  const revision = async (path: string) => {
    const info = await stat(absolute(path));
    return `${info.mtimeMs}-${info.size}`;
  };
  return {
    id: root,
    async list(path = "") {
      const relative = resolvePath(root, path).relative;
      const entries = await readdir(absolute(relative), { withFileTypes: true });
      const result: FileEntry[] = [];
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        const info = await stat(join(root, child)).catch(() => undefined);
        if (info?.isFile() || info?.isDirectory())
          result.push({ path: child, name: entry.name, kind: info.isDirectory() ? "directory" : "file", size: info.size });
      }
      return result.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
    },
    async read(path) {
      return snapshot(path, await readFile(absolute(path), "utf8"), await revision(path));
    },
    readBytes: async (path) => new Uint8Array(await readFile(absolute(path))),
    async write(path, text, writeOptions) {
      if (writeOptions.expectedRevision !== null && writeOptions.expectedRevision !== await revision(path).catch(() => null))
        throw new Error(`${path} changed on disk`);
      await mkdir(dirname(absolute(path)), { recursive: true });
      await writeFile(absolute(path), text);
      return snapshot(path, text, await revision(path));
    },
    mkdir: async (path) => void await mkdir(absolute(path), { recursive: true }),
    rename: async (path, to) => rename(absolute(path), absolute(to)),
    delete: async (path) => rm(absolute(path), { recursive: true, force: true }),
    watch: () => ({ dispose() {} }),
    async search(searchOptions, signal) {
      return await useRipgrep() ? ripgrepSearch(root, searchOptions, signal) : walkSearch(root, searchOptions, signal);
    },
    async findFiles(query, signal) {
      const term = query.trim().toLowerCase();
      let files: string[];
      if (await useRipgrep()) {
        const result = await run("rg", ["--files", "--hidden", "--glob", "!.git", "--glob", "!node_modules"], root, signal);
        if (result.code > 1) throw new Error(result.stderr.trim() || "File listing failed");
        files = result.stdout.split("\n").filter(Boolean);
      } else files = await walkFiles(root, signal);
      return files.filter((path) => !term || fuzzy(term)(path.toLowerCase())).sort().slice(0, 1000);
    },
  };
}
