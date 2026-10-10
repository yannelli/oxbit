import { lspGlobMatches } from "@oxbit/sdk";

export interface NativeFileHost {
  readFile(path: string): string | null | undefined;
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
  list(path: string): string;
  /** Bundled binary assets, such as WebAssembly modules, by file name. */
  resource?(name: string): ArrayBuffer | null | undefined;
  /** Remote JSON schema text from the host cache, download, or bundled fallback. */
  schema?(uri: string, download: boolean, completion: (text: string | null, error: string | null) => void): void;
}
export const nativeLanguageKinds = ["typescript", "json", "yaml", "dockerfile", "shell", "python"] as const;
export type NativeLanguageKind = typeof nativeLanguageKinds[number];
export interface OpenDocument { text: string; version: number; language: string }
export interface ServerOptions { root: string; rootUri: string; kind: NativeLanguageKind }
export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };

export class WorkspaceFiles {
  readonly documents = new Map<string, OpenDocument>();
  readonly root: string;
  readonly rootUri: string;
  constructor(options: ServerOptions, private host: NativeFileHost, private libraries: Record<string, string> = {}) {
    this.root = options.root.replace(/\/$/, "");
    this.rootUri = "file://" + this.root.split("/").map(encodeURIComponent).join("/");
  }
  normalize(path: string): string | undefined {
    if (path.includes("\0") || path.includes("\\")) return;
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    const result = "/" + parts.join("/");
    return result === this.root || result.startsWith(this.root + "/") ? result : undefined;
  }
  path(uri: string): string {
    if (!uri.startsWith("file:///") || /[?#]/.test(uri)) throw new Error("Language document must use a workspace file URI");
    const path = this.normalize(decodeURIComponent(uri.slice(7)));
    if (!path) throw new Error("Language document is outside the workspace");
    return path;
  }
  uri(path: string): string {
    const normalized = this.normalize(path);
    if (!normalized) throw new Error("Language result is outside the workspace");
    return this.rootUri + normalized.slice(this.root.length).split("/").map(encodeURIComponent).join("/");
  }
  readFile(path: string): string | undefined {
    if (Object.hasOwn(this.libraries, path)) return this.libraries[path];
    const normalized = this.normalize(path);
    return normalized ? this.documents.get(normalized)?.text ?? this.host.readFile(normalized) ?? undefined : undefined;
  }
  fileExists(path: string): boolean {
    if (Object.hasOwn(this.libraries, path)) return true;
    const normalized = this.normalize(path);
    return Boolean(normalized && (this.documents.has(normalized) || this.host.fileExists(normalized)));
  }
  directoryExists(path: string): boolean {
    if (path === "/__oxbit_typescript__") return true;
    const normalized = this.normalize(path);
    return Boolean(normalized && this.host.directoryExists(normalized));
  }
  list(path: string): { name: string; kind: "file" | "directory" }[] {
    const normalized = this.normalize(path);
    if (!normalized) return [];
    return JSON.parse(this.host.list(normalized));
  }
  readDirectory(path: string, extensions?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth = 32): string[] {
    const base = this.normalize(path);
    if (!base) return [];
    const result: string[] = [];
    const matches = (relative: string, pattern: string) => {
      const glob = pattern.startsWith(base + "/") ? pattern.slice(base.length + 1) : pattern.replace(/^\.\//, "");
      return lspGlobMatches(glob, relative) || !/[?*]/.test(glob) && (relative === glob || relative.startsWith(glob + "/"));
    };
    const visit = (directory: string, remaining: number) => {
      if (remaining < 0) return;
      for (const entry of this.list(directory)) {
        if (!entry.name || entry.name.includes("/") || entry.name === "." || entry.name === "..") continue;
        const file = directory + "/" + entry.name, relative = file.slice(base.length + 1);
        if (excludes?.some(pattern => matches(relative, pattern))) continue;
        if (entry.kind === "directory") {
          if (!["node_modules", ".git"].includes(entry.name)) visit(file, remaining - 1);
        } else if ((!extensions || extensions.some(extension => file.endsWith(extension))) && (!includes || includes.some(pattern => matches(relative, pattern)))) {
          result.push(file);
          if (result.length > 10000) throw new Error("iOS language project exceeds 10,000 source files");
        }
      }
    };
    visit(base, depth);
    return result;
  }
  position(path: string, offset: number): Position {
    const before = (this.readFile(path) ?? "").slice(0, offset).split("\n");
    return { line: before.length - 1, character: before.at(-1)!.length };
  }
  offset(path: string, position: Position): number {
    const lines = (this.readFile(path) ?? "").split("\n");
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.line >= lines.length || position.character < 0 || position.character > lines[position.line].replace(/\r$/, "").length)
      throw new Error("Invalid language document position");
    return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character;
  }
  range(path: string, span: { start: number; length: number }): Range {
    return { start: this.position(path, span.start), end: this.position(path, span.start + span.length) };
  }
}
