import * as fs from "node:fs/promises";
import path from "node:path";
import { settingsSchema } from "@oxbit/sdk";
import { randomUUID } from "node:crypto";
import chokidar from "chokidar";
import { mergeSettings, parseSettings, settingsLayers, settingsFile, settingsObject, validateJson, type SettingsChange, type SettingsLayers, type SettingsObject, type SettingsSnapshot } from "@oxbit/sdk";
import { RpcError } from "@oxbit/protocol";
import { WorkspaceFiles } from "./filesystem.js";

const limit = 256 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Loaded = SettingsSnapshot["files"][number] & { value: SettingsObject; text?: string };

/** File settings shared by every browser and desktop connected to this runtime. */
export class SettingsStore {
  /** Local schema supports external editors even with no network access. */
  get schemaFile() { return path.join(path.dirname(this.userFile), "schemas", "settings.v1.schema.json"); }
  readonly paths: string[];
  private valid = new Map<string, SettingsObject>();
  private watcher?: ReturnType<typeof chokidar.watch>;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private files: WorkspaceFiles, readonly userFile: string, readonly projectDirectory: string, private changed: () => void = () => {}) {
    this.userFile = path.resolve(userFile);
    this.projectDirectory = path.resolve(projectDirectory);
    this.paths = [this.userFile, path.join(this.projectDirectory, "settings.json"), path.join(files.root, ".config/oxbit/settings.json"), path.join(files.root, ".config/oxbit/settings.local.json")];
  }
  async initialize() {
    await fs.mkdir(path.dirname(this.userFile), { recursive: true, mode: 0o700 });
    await fs.mkdir(this.projectDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(this.schemaFile), { recursive: true, mode: 0o700 });
    const schemaText = JSON.stringify(settingsSchema, null, 2) + "\n";
    if (await fs.readFile(this.schemaFile, "utf8").catch(error => { if (missing(error)) return ""; throw error; }) !== schemaText) {
      const temporary = this.schemaFile + "." + randomUUID();
      try { await fs.writeFile(temporary, schemaText, { mode: 0o600 }); await fs.rename(temporary, this.schemaFile); }
      finally { await fs.rm(temporary, { force: true }); }
    }
    this.watcher = chokidar.watch([path.dirname(this.userFile), this.projectDirectory, this.files.root], {
      ignoreInitial: true, followSymlinks: false, usePolling: true, interval: 150,
      ignored: file => !this.paths.some(target => target === file || target.startsWith(file + path.sep)),
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    this.watcher.on("all", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.changed(), 75);
      this.timer.unref();
    });
    this.watcher.on("error", () => this.changed());
    await new Promise<void>((resolve, reject) => { this.watcher!.once("ready", resolve); this.watcher!.once("error", reject); });
    return this;
  }
  private async authorized(file: string) {
    // A repository cannot redirect settings reads or writes outside its authorized root.
    if (file !== this.userFile && (file === this.paths[2] || file === this.paths[3] || file === path.join(this.files.root, ".oxbit/settings.json"))) await this.files.resolve(path.relative(this.files.root, file), true);
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("Settings files must not be symbolic links"); }
    catch (error) { if (!missing(error)) throw error; }
  }
  private async readFile(file: string, scope: "user" | "workspace"): Promise<Loaded> {
    try {
      await this.authorized(file);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > limit) throw new Error("Settings must be a file smaller than 256 KiB");
      const text = await fs.readFile(file, "utf8"), value = parseSettings(JSON.parse(text));
      this.valid.set(file, value);
      return { path: file, scope, exists: true, value, text };
    } catch (error) {
      if (missing(error)) { this.valid.delete(file); return { path: file, scope, exists: false, value: {} }; }
      return { path: file, scope, exists: true, value: this.valid.get(file) ?? {}, error: String(error) };
    }
  }
  private async loaded() { return Promise.all(this.paths.map((file, index) => this.readFile(file, index ? "workspace" : "user"))); }
  async effective(): Promise<SettingsObject> {
    return (await this.loaded()).reduce<SettingsObject>((result, item) => mergeSettings(result, item.value) as SettingsObject, {});
  }
  private snapshot(loaded: Loaded[]): SettingsSnapshot {
    return { layers: settingsLayers(loaded[0].value, loaded.slice(1).reduce((result, item) => mergeSettings(result, item.value) as SettingsObject, {})), files: loaded.map(({ value: _value, text: _text, ...file }) => file) };
  }
  private async create(file: string, value: SettingsObject) {
    await this.authorized(file);
    const schemaUri = path.relative(path.dirname(file), this.schemaFile).split(path.sep).map(encodeURIComponent).join("/");
    const text = JSON.stringify({ $schema: schemaUri, ...value }, null, 2) + "\n";
    if (Buffer.byteLength(text) > limit) throw new Error("Settings exceed 256 KiB");
    try { await fs.writeFile(file, text, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  async read(legacy?: SettingsLayers): Promise<SettingsSnapshot> {
    const user = legacy ? parseSettings(settingsFile(legacy, "user")) : {};
    let workspace = legacy ? parseSettings(settingsFile(legacy, "workspace")) : {};
    // Migrate the former repository file once, without overwriting the private project file.
    if (!(await this.readFile(this.paths[1], "workspace")).exists) {
      const legacyPath = path.join(this.files.root, ".oxbit/settings.json");
      const old = legacyPath === this.userFile ? { value: {}, error: undefined } : await this.readFile(legacyPath, "workspace");
      if (old.error) throw new Error(`Legacy workspace settings could not be migrated: ${old.error}`);
      workspace = mergeSettings(workspace, old.value) as SettingsObject;
    }
    await this.create(this.userFile, user);
    await this.create(this.paths[1], workspace);
    return this.snapshot(await this.loaded());
  }
  /** Serialize processes as well as tabs. Editors still get optimistic revision checks. */
  private async lock(file: string) {
    const lock = file + ".lock", until = Date.now() + 5000;
    while (true) {
      try {
        const handle = await fs.open(lock, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        return async () => { await handle.close(); await fs.rm(lock, { force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Recover a lock left by a dead runtime, but never steal an active writer's lock.
        try {
          const pid = Number(await fs.readFile(lock, "utf8"));
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ESRCH") { await fs.rm(lock, { force: true }); continue; } }
          }
        } catch { /* The owner may have just released its lock. */ }
        if (Date.now() >= until) throw new RpcError("CONFLICT", "Settings are being saved by another window. Try again.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  async patch(input: unknown): Promise<SettingsSnapshot> {
    validateJson(input);
    if (!Array.isArray(input) || input.length > 1000) throw new RpcError("INVALID_PARAMS", "Invalid settings changes");
    for (const change of input) {
      if (!settingsObject(change) || !["user", "workspace"].includes(change.scope as string) || !Array.isArray(change.path) || !change.path.length || change.path.length > 32 || change.path.some(key => typeof key !== "string" || !key || key.length > 1024 || ["__proto__", "constructor", "prototype", "$schema"].includes(key))) throw new RpcError("INVALID_PARAMS", "Invalid settings change path");
    }
    const changes = structuredClone(input) as unknown as SettingsChange[];
    const operation = this.queue.catch(() => {}).then(async () => {
      const unlockUser = await this.lock(this.userFile);
      try {
        const unlockProject = await this.lock(this.paths[1]);
        try { return await this.apply(changes); } finally { await unlockProject(); }
      } finally { await unlockUser(); }
    });
    this.queue = operation;
    return operation;
  }
  private async apply(changes: SettingsChange[]) {
    const loaded = await this.loaded(), current = this.snapshot(loaded).layers;
    const logical = { user: settingsFile(current, "user"), workspace: settingsFile(current, "workspace") };
    const workspace = loaded.slice(1).findLast(item => item.exists) ?? loaded[1];
    const targets = new Map<Loaded, SettingsObject>();
    for (const change of changes) {
      const target = change.scope === "user" ? loaded[0] : workspace;
      if (loaded.filter(item => item.scope === change.scope).some(item => item.error)) throw new RpcError("CONFLICT", "Fix invalid settings JSON before saving this scope");
      let existing: unknown = logical[change.scope];
      for (const key of change.path) existing = settingsObject(existing) ? existing[key] : undefined;
      if (!same(existing, change.before) && !same(existing, change.value)) throw new RpcError("CONFLICT", `Setting ${change.path.join(" / ")} changed on disk. Reload settings or retry your change.`);
      const value = targets.get(target) ?? structuredClone(target.value);
      targets.set(target, value);
      let cursor = value;
      for (const key of change.path.slice(0, -1)) {
        if (!settingsObject(cursor[key])) cursor[key] = {};
        cursor = cursor[key] as SettingsObject;
      }
      const key = change.path.at(-1)!;
      if (Object.hasOwn(change, "value")) cursor[key] = structuredClone(change.value);
      else delete cursor[key];
      let next = logical[change.scope];
      for (const part of change.path.slice(0, -1)) {
        if (!settingsObject(next[part])) next[part] = {};
        next = next[part] as SettingsObject;
      }
      if (Object.hasOwn(change, "value")) next[key] = structuredClone(change.value); else delete next[key];
    }
    // Validate the entire batch before writing either scope.
    const writes = [...targets].map(([target, value]) => {
      parseSettings(value);
      const text = JSON.stringify(value, null, 2) + "\n";
      if (Buffer.byteLength(text) > limit) throw new Error("Settings exceed 256 KiB");
      return { target, text };
    });
    for (const { target, text } of writes) {
      await this.authorized(target.path);
      const latest = await this.readFile(target.path, target.scope);
      if (latest.error || latest.text !== target.text) throw new RpcError("CONFLICT", "Settings changed while saving. Reload and retry.");
      const temporary = target.path + "." + randomUUID();
      try { await fs.writeFile(temporary, text, { mode: 0o600 }); await fs.rename(temporary, target.path); }
      finally { await fs.rm(temporary, { force: true }); }
    }
    const result = this.snapshot(await this.loaded());
    if (changes.length) this.changed();
    return result;
  }
  async dispose() { clearTimeout(this.timer); await this.watcher?.close(); await this.queue.catch(() => {}); }
}
