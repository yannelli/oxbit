import * as fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import ts from "typescript";
import ignore, { type Ignore } from "ignore";
import { matchesFilePattern, resolveLanguage, validateJson, mergeSettings, type SettingsObject, type ProjectConfiguration, type ProjectFile, type ProjectInfo, type ProjectIntelligence, type ProjectPackage, type ProjectRelations } from "@oxbit/sdk";
import { WorkspaceFiles } from "./filesystem.js";

const excludedDirectories = new Set([".git", "node_modules", "vendor", "dist", "dist-types", "build", "coverage", ".next", ".nuxt", ".cache", ".oxbit", ".venv", "__pycache__", "target"]);
const sourcePattern = /\.(?:[cm]?[jt]sx?|mdx|vue|astro)$/i;

export function projectId(root: string) {
  const hash = createHash("sha1").update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex")).update(pathToFileURL(root).href).digest();
  hash[6] = (hash[6] & 15) | 0x50; hash[8] = (hash[8] & 63) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function atomicJson(file: string, value: unknown) {
  const temporary = file + "." + randomUUID();
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
export function validateProject(value: unknown, id: string, root: string): asserts value is ProjectConfiguration {
  validateJson(value);
  const p = value as unknown as ProjectConfiguration;
  if (!p || p.schemaVersion !== 1 || p.id !== id || p.root !== root || typeof p.name !== "string" || typeof p.notes !== "string") throw new Error("Invalid project.json identity or metadata");
  const i = p.intelligence, s = p.schemas;
  if (!i || typeof i.enabled !== "boolean" || !Array.isArray(i.exclude) || i.exclude.some(item => typeof item !== "string" || item.length > 1024) || !Number.isInteger(i.maxFiles) || i.maxFiles < 1 || i.maxFiles > 100_000 || !Number.isInteger(i.maxFileBytes) || i.maxFileBytes < 1 || i.maxFileBytes > 5 * 1024 * 1024) throw new Error("Invalid project intelligence settings");
  if (!s || typeof s.catalog !== "boolean" || typeof s.download !== "boolean" || !Array.isArray(s.associations) || s.associations.length > 1000) throw new Error("Invalid project schema settings");
  for (const a of s.associations) {
    if (!a || typeof a !== "object" || a.url !== undefined && typeof a.url !== "string" || a.fileMatch !== undefined && (!Array.isArray(a.fileMatch) || a.fileMatch.some(item => typeof item !== "string" || item.length > 1024)) || a.schema === undefined && !a.url || a.schema !== undefined && (a.schema === null || typeof a.schema !== "boolean" && (typeof a.schema !== "object" || Array.isArray(a.schema)))) throw new Error("Invalid project schema association");
  }
}

/** One private, deterministic UUID per canonical workspace. Generated data never overwrites user configuration. */
export class ProjectStore {
  readonly id: string;
  readonly directory: string;
  private configuration!: ProjectConfiguration;
  private index?: ProjectIntelligence;
  private state: ProjectInfo["state"] = "idle";
  private error?: string;
  private running?: Promise<void>;
  private dirty = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private watcher?: FSWatcher;
  private settings?: () => Promise<SettingsObject>;
  useSettings(read: () => Promise<SettingsObject>) { this.settings = read; }
  constructor(private files: WorkspaceFiles, base: string, private changed: () => void = () => {}) {
    this.id = projectId(files.root); this.directory = path.join(base, this.id);
  }
  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const defaults: ProjectConfiguration = { schemaVersion: 1, id: this.id, root: this.files.root, name: path.basename(this.files.root), notes: "", intelligence: { enabled: true, exclude: [], maxFiles: 20_000, maxFileBytes: 1024 * 1024 }, schemas: { catalog: true, download: true, associations: [] } };
    this.configuration = defaults;
    try { await fs.writeFile(path.join(this.directory, "project.json"), JSON.stringify(defaults, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try { await this.reload(); } catch (error) { this.state = "failed"; this.error = String(error); }
    this.watcher = watch(this.directory, (_event, filename) => { if (filename?.toString() === "project.json") { this.changed(); this.invalidate(); } });
    this.watcher.on("error", error => { this.error = String(error); });
    this.watcher.unref();
    return this;
  }
  async reload() {
    const file = path.join(this.directory, "project.json");
    if ((await fs.stat(file)).size > 1024 * 1024) throw new Error("project.json exceeds 1 MiB");
    let value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    const settings = await this.settings?.();
    if (settings) value = mergeSettings(value, {
      ...(Object.hasOwn(settings, "project.intelligence") ? { intelligence: settings["project.intelligence"] } : {}),
      ...(Object.hasOwn(settings, "project.schemas") ? { schemas: settings["project.schemas"] } : {}),
    });
    validateProject(value, this.id, this.files.root); this.configuration = value; return value;
  }
  info(): ProjectInfo {
    return { configuration: this.configuration, directory: this.directory, state: this.state, error: this.error, generatedAt: this.index?.generatedAt, fileCount: this.index?.files.length ?? 0, packageCount: this.index?.packages.length ?? 0, frameworks: this.index?.frameworks ?? [], warnings: this.index?.warnings ?? [] };
  }
  invalidate() {
    if (this.closed) return;
    this.dirty = true; clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refresh().catch(() => {}); }, 500); this.timer.unref();
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    clearTimeout(this.timer);
    if (this.running) { this.dirty = true; return this.running; }
    this.running = (async () => {
      do {
        this.dirty = false;
        try {
          const config = await this.reload(); this.error = undefined;
          if (!config.intelligence.enabled) { this.index = undefined; this.state = "disabled"; break; }
          this.state = "indexing";
          const index = await this.analyze(config);
          if (this.closed) break;
          await atomicJson(path.join(this.directory, "intelligence.json"), index);
          this.index = index; this.state = "ready";
        } catch (error) { this.error = String(error); this.state = "failed"; }
      } while (this.dirty && !this.closed);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  async snapshot() { if (this.running) await this.running; else if (!this.index || this.dirty) await this.refresh(); return this.index; }
  async relations(relative: string): Promise<ProjectRelations> {
    await this.files.resolve(relative, true);
    const index = await this.snapshot(), file = index?.files.find(item => item.path === relative);
    const importedBy = index?.files.filter(item => item.imports.some(edge => edge.target === relative)).map(item => item.path) ?? [];
    const reverse = new Map<string, string[]>();
    for (const source of index?.files ?? []) for (const edge of source.imports) if (edge.target) { const values = reverse.get(edge.target) ?? []; values.push(source.path); reverse.set(edge.target, values); }
    const affected = new Set<string>(), queue = [...importedBy];
    for (let i = 0; i < queue.length; i++) { const item = queue[i]; if (item === relative || affected.has(item)) continue; affected.add(item); queue.push(...reverse.get(item) ?? []); }
    const related: ProjectRelations["related"] = [...(file?.imports ?? []).filter(edge => edge.target).map(edge => ({ path: edge.target!, reason: "imports" as const })), ...importedBy.map(item => ({ path: item, reason: "imported by" as const }))];
    const stem = (item: string) => path.basename(item).replace(/\.(test|spec)(?=\.)/, "").replace(/\.[^.]+$/, "");
    for (const item of index?.files ?? []) if (item.path !== relative && stem(item.path) === stem(relative) && /\.(?:test|spec)\./.test(item.path + " " + relative) && !related.some(value => value.path === item.path)) related.push({ path: item.path, reason: "matching test or source" });
    return { path: relative, imports: file?.imports ?? [], importedBy, affected: [...affected].sort(), related };
  }
  private async analyze(config: ProjectConfiguration): Promise<ProjectIntelligence> {
    const result: ProjectIntelligence = { schemaVersion: 1, projectId: this.id, generatedAt: new Date().toISOString(), files: [], packages: [], frameworks: [], warnings: [], truncated: false };
    const texts = new Map<string, string>(), fullPaths = new Map<string, string>(), folders = new Set<string>();
    const queue = [""]; let bytes = 0;
    const ignores = new Map<string, Ignore>();
    for (let at = 0; at < queue.length && !this.closed; at++) {
      const directory = queue[at]; folders.add(path.join(this.files.root, directory));
      let directoryPath: string;
      try { directoryPath = await this.files.resolve(directory); } catch { continue; }
      if (directoryPath === this.directory || directoryPath.startsWith(this.directory + path.sep)) continue;
      try {
        const ignoreFile = await this.files.resolve(path.posix.join(directory, ".gitignore"));
        if ((await fs.stat(ignoreFile)).size <= 256 * 1024) ignores.set(directory, ignore().add(await fs.readFile(ignoreFile, "utf8")));
      } catch { /* Git ignores are optional. */ }
      const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = path.posix.join(directory, entry.name);
        if (entry.isSymbolicLink() || entry.name.startsWith(".oxbit-tmp-") || config.intelligence.exclude.some(pattern => matchesFilePattern(pattern, relative) || matchesFilePattern(pattern, relative + "/"))) continue;
        let ignored = false;
        for (const [base, rules] of ignores) if (!base || relative.startsWith(base + "/")) {
          const match = rules.test(relative.slice(base ? base.length + 1 : 0) + (entry.isDirectory() ? "/" : ""));
          if (match.ignored) ignored = true; else if (match.unignored) ignored = false;
        }
        if (ignored) continue;
        if (entry.isDirectory()) {
          if (!excludedDirectories.has(entry.name)) { if (queue.length < config.intelligence.maxFiles) queue.push(relative); else result.truncated = true; }
          continue;
        }
        if (!entry.isFile()) continue;
        if (result.files.length >= config.intelligence.maxFiles) { result.truncated = true; break; }
        let full: string;
        try { full = await this.files.resolve(relative); } catch { continue; }
        // Never include private project data when the user opens a parent directory as a workspace.
        if (full === this.directory || full.startsWith(this.directory + path.sep)) continue;
        const stat = await fs.stat(full).catch(() => undefined); if (!stat) continue;
        fullPaths.set(full, relative);
        const record: ProjectFile = { path: relative, language: resolveLanguage(relative).id, size: stat.size, imports: [], symbols: [] }; result.files.push(record);
        if (stat.size > config.intelligence.maxFileBytes || bytes + stat.size > 32 * 1024 * 1024) { if (sourcePattern.test(relative) || /(?:package|composer|[jt]sconfig[^/]*)\.json$/.test(relative)) result.warnings.push(`Skipped analysis of ${relative}: size budget`); continue; }
        if (sourcePattern.test(relative) || /(?:package|composer|[jt]sconfig[^/]*)\.json$/.test(relative)) {
          const text = await fs.readFile(full, "utf8").catch(() => ""); bytes += stat.size; texts.set(full, text);
          if (entry.name === "package.json" || entry.name === "composer.json") {
            try {
              const data = JSON.parse(text), ecosystem = entry.name === "package.json" ? "npm" : "composer";
              const pkg: ProjectPackage = { path: relative, name: typeof data.name === "string" ? data.name : directory || config.name, ecosystem, dependencies: [] };
              for (const kind of ecosystem === "npm" ? ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] : ["require", "require-dev"]) for (const [name, version] of Object.entries(data[kind] ?? {})) if (typeof version === "string") pkg.dependencies.push({ name, version, kind });
              result.packages.push(pkg);
            } catch { result.warnings.push(`Invalid manifest: ${relative}`); }
          }
        }
      }
      if (result.truncated) break;
      // Yield between directories so large workspaces do not block runtime requests.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const host: ts.ModuleResolutionHost = { fileExists: file => fullPaths.has(path.normalize(file)), readFile: file => texts.get(path.normalize(file)), directoryExists: file => folders.has(path.normalize(file)), realpath: file => file, getCurrentDirectory: () => this.files.root };
    const configs = new Map<string, ts.CompilerOptions>();
    const compilerOptions = (full: string) => {
      let directory = path.dirname(full);
      while (this.files.inside(directory)) {
        for (const name of ["tsconfig.json", "jsconfig.json"]) {
          const file = path.join(directory, name), text = texts.get(file);
          if (text !== undefined) {
            if (!configs.has(file)) {
              const config = ts.parseConfigFileTextToJson(file, text);
              const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, { ...host, useCaseSensitiveFileNames: true, readDirectory: () => [] }, directory);
              configs.set(file, parsed.options);
              if (config.error || parsed.errors.some(error => error.code !== 18003)) result.warnings.push(`Incomplete TypeScript configuration: ${path.relative(this.files.root, file)}`);
            }
            return configs.get(file)!;
          }
        }
        if (directory === this.files.root) break; directory = path.dirname(directory);
      }
      return { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
    };
    const candidate = (base: string) => {
      const values = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".mdx", ".vue", ".astro", ".json"].flatMap(ext => [base + ext, path.join(base, "index" + ext)])];
      return values.find(file => fullPaths.has(file));
    };
    const workspacePackages = new Map(result.packages.filter(pkg => pkg.ecosystem === "npm").map(pkg => [pkg.name, pkg.path]));
    const exportPath = (value: any): string | undefined => typeof value === "string" ? value : Array.isArray(value) ? value.map(exportPath).find(Boolean) : value && typeof value === "object" ? exportPath(value.types ?? value.import ?? value.default ?? value.require) : undefined;
    let analyzed = 0;
    for (const record of result.files) {
      if (this.closed) break;
      if (++analyzed % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      if (!sourcePattern.test(record.path)) continue;
      const full = path.join(this.files.root, record.path), text = texts.get(full); if (text === undefined) continue;
      const source = /\.(mdx|vue|astro)$/.test(record.path) ? embeddedScript(text, record.language) : text;
      const options = compilerOptions(full);
      const imports = ts.preProcessFile(source, true, true).importedFiles;
      record.imports = [...new Set(imports.map(item => item.fileName))].map(specifier => {
        let target = ts.resolveModuleName(specifier, full, options, host).resolvedModule?.resolvedFileName;
        if (!target && specifier.startsWith(".")) target = candidate(path.resolve(path.dirname(full), specifier));
        if (!target) for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
          const [prefix, suffix = ""] = pattern.split("*");
          if (pattern.includes("*") ? specifier.startsWith(prefix) && specifier.endsWith(suffix) : specifier === pattern) {
            const matched = pattern.includes("*") ? specifier.slice(prefix.length, specifier.length - suffix.length) : "";
            for (const value of targets) { target = candidate(path.resolve(options.baseUrl ?? (options as any).pathsBasePath ?? this.files.root, value.replace("*", matched))); if (target) break; }
          }
          if (target) break;
        }
        const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        const workspaceManifest = workspacePackages.get(packageName);
        if (!target && workspaceManifest) {
          const file = path.join(this.files.root, workspaceManifest), manifest = JSON.parse(texts.get(file)!);
          const subpath = specifier.slice(packageName.length), key = subpath ? "." + subpath : ".";
          const entry = exportPath(manifest.exports?.[key] ?? (!subpath ? manifest.exports : undefined)) ?? (!subpath ? manifest.types ?? manifest.typings ?? manifest.module ?? manifest.main ?? "index" : subpath.slice(1));
          if (typeof entry === "string") target = candidate(path.resolve(path.dirname(file), entry));
        }
        return { specifier, ...(target && fullPaths.has(target) ? { target: fullPaths.get(target) } : !specifier.startsWith(".") && !specifier.startsWith("/") ? { package: specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0] } : {}) };
      });
      const ast = ts.createSourceFile(record.path, source, ts.ScriptTarget.Latest, false, /x$/.test(record.path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const statement of ast.statements) {
        const names = ts.isVariableStatement(statement) ? statement.declarationList.declarations.map(item => item.name) : "name" in statement ? [(statement as ts.DeclarationStatement).name] : [];
        for (const name of names) if (name && ts.isIdentifier(name) && record.symbols.length < 100) record.symbols.push({ name: name.text, kind: ts.SyntaxKind[statement.kind], line: ast.getLineAndCharacterOfPosition(name.getStart(ast)).line + 1 });
      }
    }
    const dependencies = new Set(result.packages.flatMap(pkg => pkg.dependencies.map(item => item.name)));
    result.frameworks = ["laravel/framework", "next", "nuxt", "astro", "vue", "react", "@mdx-js/mdx"].filter(name => dependencies.has(name));
    if (result.truncated) result.warnings.push(`File/directory inventory reached the ${config.intelligence.maxFiles} entry budget`);
    result.warnings = result.warnings.slice(0, 100);
    return result;
  }
  async dispose() { this.closed = true; clearTimeout(this.timer); this.watcher?.close(); await this.running; }
}

function embeddedScript(text: string, language: string) {
  // Keep line offsets while selecting script regions. This is static import/symbol extraction, not compilation.
  const ranges: { start: number; end: number }[] = [];
  if (language === "astro") { const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); if (match) ranges.push({ start: text.indexOf(match[1]), end: text.indexOf(match[1]) + match[1].length }); }
  if (language === "vue" || language === "astro") for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) { const start = match.index! + match[0].indexOf(">") + 1; ranges.push({ start, end: start + match[1].length }); }
  if (language === "mdx") {
    let offset = 0, fence = "";
    for (const line of text.split(/(?<=\n)/)) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""; }
      else if (!fence && /^(?:import|export)\b/.test(line) && !ranges.some(range => offset < range.end)) {
        const end = /\r?\n[ \t]*\r?\n/.exec(text.slice(offset));
        ranges.push({ start: offset, end: end ? offset + end.index : text.length });
      }
      offset += line.length;
    }
  }
  let cursor = 0, result = "";
  for (const range of ranges.sort((a, b) => a.start - b.start)) { result += text.slice(cursor, range.start).replace(/[^\r\n]/g, " ") + text.slice(range.start, range.end); cursor = range.end; }
  return result + text.slice(cursor).replace(/[^\r\n]/g, " ");
}
