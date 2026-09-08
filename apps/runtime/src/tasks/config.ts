import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { RpcError } from "@oxbit/protocol";
import type {
  ConfiguredTask,
  TaskCatalog,
  TaskDefinition,
  TaskHooks,
  TaskSource,
  TaskSourceKind,
} from "@oxbit/sdk";
import { runCommand } from "../processes.js";
import { readSource, json, writeTask, writeSettings } from "./adapters.js";
import { definition, hooks, stringMap, taskName } from "./validation.js";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
export async function readOptional(file: string) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
/** Stable RFC 9562 version 5 UUID, shared by linked worktrees of a repository. */
export function projectUuid(identity: string) {
  const bytes = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update("oxbit:project:" + identity)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function fileLock<T>(
  file: string,
  action: () => Promise<T>,
): Promise<T> {
  const lock = file + ".lock";
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await fs.open(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readOptional(lock));
      let alive = true;
      if (Number.isSafeInteger(pid) && pid > 0)
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
      if (alive || attempt)
        throw new RpcError(
          "CONFIG_BUSY",
          "Another process is modifying this configuration; retry after it finishes",
        );
      await fs.unlink(lock);
    }
  }
  if (!handle) throw new RpcError("CONFIG_BUSY", "Configuration is locked");
  try {
    await handle.writeFile(String(process.pid));
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(lock).catch(() => {});
  }
}
export async function atomicWrite(
  file: string,
  text: string,
  expected: string | null,
) {
  await fileLock(file, async () => {
    const current = await readOptional(file);
    if ((current === null ? null : digest(current)) !== expected)
      throw new RpcError(
        "CONFLICT",
        "Configuration changed on disk. Refresh before saving; your edits have not been written.",
      );
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const mode =
        current === null ? 0o600 : (await fs.stat(file)).mode & 0o777;
      await fs.writeFile(temp, text.endsWith("\n") ? text : text + "\n", {
        mode,
        flag: "wx",
      });
      // Editors do not participate in our lock; check again immediately before rename.
      const latest = await readOptional(file);
      if ((latest === null ? null : digest(latest)) !== expected)
        throw new RpcError("CONFLICT", "Configuration changed during save");
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  });
}
export class TaskConfigStore {
  readonly privatePath: string;
  private constructor(
    readonly root: string,
    readonly projectId: string,
    readonly projectHome: string,
    readonly gitPath: string,
  ) {
    this.privatePath = path.join(projectHome, "tasks.json");
  }
  static async create(
    root: string,
    options: { home?: string; gitPath?: string } = {},
  ) {
    root = await fs.realpath(root);
    const gitPath = options.gitPath ?? "git";
    let identity = root;
    try {
      const result = await runCommand(
        gitPath,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: root, maxBytes: 8192 },
      );
      if (result.exitCode === 0) {
        const common = await fs.realpath(result.stdout.trim());
        identity =
          path.basename(common) === ".git" ? path.dirname(common) : common;
      }
    } catch {
      /* Non-Git projects use the canonical directory. */
    }
    const id = projectUuid(identity),
      home = path.join(options.home ?? os.homedir(), ".oxbit", "projects", id);
    return new TaskConfigStore(root, id, home, gitPath);
  }
  private async safePath(file: string) {
    const base = file === this.privatePath ? this.projectHome : this.root;
    let current = base;
    for (const segment of path.relative(base, file).split(path.sep)) {
      if (!segment || segment === "..")
        throw new RpcError(
          "INVALID_PATH",
          "Configuration must be within its project",
        );
      current = path.join(current, segment);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink())
          throw new RpcError(
            "INVALID_PATH",
            "Task configuration paths cannot be symlinks",
          );
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
  async branch() {
    try {
      const result = await runCommand(
        this.gitPath,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        { cwd: this.root, maxBytes: 8192 },
      );
      return result.exitCode === 0 ? result.stdout.trim() : "";
    } catch {
      return "";
    }
  }
  async catalog(): Promise<TaskCatalog> {
    const candidates: {
      file: string;
      kind: TaskSourceKind;
      private?: boolean;
    }[] = [
      { file: ".oxbit/tasks.json", kind: "oxbit" },
      { file: "paseo.json", kind: "paseo" },
      { file: ".vscode/tasks.json", kind: "vscode" },
      { file: ".vscode/launch.json", kind: "vscode-launch" },
    ];
    for (const directory of [".run", ".idea/runConfigurations"]) {
      try {
        const entries = await fs.readdir(path.join(this.root, directory), {
          withFileTypes: true,
        });
        for (const entry of entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 128))
          if (entry.isFile() && entry.name.endsWith(".xml"))
            candidates.push({
              file: path.join(directory, entry.name),
              kind: "jetbrains",
            });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    candidates.push(
      { file: ".idea/workspace.xml", kind: "jetbrains" },
      { file: "package.json", kind: "npm" },
      { file: "composer.json", kind: "composer" },
      { file: "Procfile", kind: "procfile" },
      { file: "Makefile", kind: "make" },
      { file: "justfile", kind: "just" },
      { file: this.privatePath, kind: "oxbit", private: true },
    );
    const sources: TaskSource[] = [],
      tasks: ConfiguredTask[] = [];
    let worktree: TaskHooks = {},
      env: Record<string, string> = {},
      settingsFound = false,
      noImports = false;
    for (const candidate of candidates) {
      if (noImports) continue;
      const file = path.resolve(this.root, candidate.file),
        source: TaskSource = {
          id: digest(candidate.private ? "private" : candidate.file).slice(
            0,
            16,
          ),
          kind: candidate.kind,
          path: file,
          revision: null,
          private: candidate.private === true,
          writable: !["make", "just"].includes(candidate.kind),
          diagnostics: [],
        };
      try {
        await this.safePath(file);
        const stat = await fs.stat(file).catch((error) => {
          if (missing(error)) return null;
          throw error;
        });
        if (!stat) continue;
        if (!stat.isFile() || stat.size > 1048576)
          throw new Error("Configuration must be a file smaller than 1 MiB");
        const text = await fs.readFile(file, "utf8");
        source.revision = digest(text);
        const parsed = readSource(candidate.kind, text);
        if (
          !["oxbit", "paseo", "vscode"].includes(candidate.kind) &&
          !parsed.tasks.length
        )
          continue;
        source.diagnostics = parsed.diagnostics;
        if (candidate.kind === "oxbit" && !candidate.private)
          noImports = json(text).autoDetect === false;
        if (
          !settingsFound &&
          source.writable &&
          !["procfile"].includes(source.kind)
        ) {
          worktree = parsed.worktree;
          env = parsed.env;
          settingsFound = true;
        }
        for (const task of parsed.tasks)
          tasks.push({
            ...task.definition,
            id: source.id + "/" + encodeURIComponent(task.name),
            name: task.name,
            sourceId: source.id,
            ...(task.sourceCommand === undefined
              ? {}
              : { sourceCommand: task.sourceCommand }),
            ...(task.disabledReason
              ? { disabledReason: task.disabledReason }
              : {}),
          });
      } catch (error) {
        source.diagnostics.push(String((error as Error).message));
        source.writable = false;
      }
      sources.push(source);
    }
    if (!noImports && !sources.some((source) => source.private))
      sources.push({
        id: digest("private").slice(0, 16),
        kind: "oxbit",
        path: this.privatePath,
        revision: null,
        private: true,
        writable: true,
        diagnostics: [],
      });
    const selected =
      sources.find((s) => s.writable && !s.private) ??
      sources.find((s) => s.private)!;
    return {
      projectId: this.projectId,
      projectDir: this.root,
      privatePath: this.privatePath,
      defaultSourceId: selected.id,
      sources,
      tasks,
      worktree,
      env,
    };
  }
  private async source(id: string, expected: unknown) {
    const catalog = await this.catalog(),
      source = catalog.sources.find((source) => source.id === id);
    if (!source)
      throw new RpcError("NOT_FOUND", "Task source no longer exists");
    if (!source.writable)
      throw new RpcError(
        "READ_ONLY",
        source.diagnostics.join("\n") || "This task source is read-only",
      );
    if (expected !== source.revision)
      throw new RpcError(
        "CONFLICT",
        "Configuration changed. Refresh before saving; your edits are retained.",
      );
    await this.safePath(source.path);
    const text = await readOptional(source.path);
    if ((text === null ? null : digest(text)) !== expected)
      throw new RpcError("CONFLICT", "Configuration changed during read");
    return {
      source,
      text:
        text ??
        '{\n  "version": 1,\n  "tasks": {},\n  "worktree": { "preinit": "", "init": "", "preteardown": "", "teardown": "" }\n}\n',
    };
  }
  async save(input: {
    sourceId: string;
    name: string;
    task?: unknown;
    sourceCommand?: string;
    expectedRevision: unknown;
    create?: boolean;
  }) {
    const name = taskName(input.name),
      { source, text } = await this.source(
        input.sourceId,
        input.expectedRevision,
      );
    const task = input.task === undefined ? undefined : definition(input.task);
    if (
      input.create &&
      readSource(source.kind, text).tasks.some((task) => task.name === name)
    )
      throw new RpcError(
        "CONFLICT",
        "A task with this name already exists in this source",
      );
    if (
      input.sourceCommand !== undefined &&
      (typeof input.sourceCommand !== "string" ||
        input.sourceCommand.length > 32768 ||
        input.sourceCommand.includes("\0"))
    )
      throw new RpcError("INVALID_PARAMS", "Invalid source command");
    const next = writeTask(source.kind, text, name, task, input.sourceCommand);
    readSource(source.kind, next);
    await atomicWrite(source.path, next, source.revision);
    return this.catalog();
  }
  async saveSettings(input: {
    sourceId: string;
    worktree: unknown;
    env: unknown;
    expectedRevision: unknown;
  }) {
    const { source, text } = await this.source(
      input.sourceId,
      input.expectedRevision,
    );
    const next = writeSettings(
      source.kind,
      text,
      {
        preinit: "",
        init: "",
        preteardown: "",
        teardown: "",
        ...hooks(input.worktree),
      },
      stringMap(input.env, "env"),
    );
    readSource(source.kind, next);
    await atomicWrite(source.path, next, source.revision);
    return this.catalog();
  }
  async share(expectedRevisions: Record<string, string | null>) {
    const catalog = await this.catalog();
    for (const source of catalog.sources)
      if (expectedRevisions[source.id] !== source.revision)
        throw new RpcError(
          "CONFLICT",
          "Configuration changed; refresh before saving in the project",
        );
    const file = path.join(this.root, ".oxbit/tasks.json");
    await this.safePath(file);
    if ((await readOptional(file)) !== null)
      throw new RpcError(
        "CONFLICT",
        ".oxbit/tasks.json already exists; edit its tasks directly",
      );
    const tasks: Record<string, TaskDefinition> = {},
      names = new Map<string, string>();
    const supported = catalog.tasks.filter((task) => !task.disabledReason);
    for (const task of supported) {
      let name = task.name;
      if (Object.hasOwn(tasks, name))
        name += ` (${catalog.sources.find((s) => s.id === task.sourceId)!.kind})`;
      for (let i = 2; Object.hasOwn(tasks, name); i++)
        name = `${task.name} (${i})`;
      names.set(task.id, name);
      tasks[name] = { command: "" };
    }
    for (const task of supported) {
      const {
        id,
        name: _name,
        sourceId,
        sourceCommand: _command,
        disabledReason: _reason,
        ...def
      } = task;
      tasks[names.get(id)!] = {
        ...def,
        ...(def.dependsOn
          ? {
              dependsOn: def.dependsOn.map((name) => {
                const other =
                  supported.find((t) => t.id === name) ??
                  supported.find(
                    (t) => t.name === name && t.sourceId === sourceId,
                  );
                return other ? names.get(other.id)! : name;
              }),
            }
          : {}),
      };
    }
    await atomicWrite(
      file,
      JSON.stringify(
        {
          version: 1,
          autoDetect: false,
          tasks,
          env: catalog.env,
          worktree: {
            preinit: "",
            init: "",
            preteardown: "",
            teardown: "",
            ...catalog.worktree,
          },
        },
        null,
        2,
      ),
      null,
    );
    return {
      catalog: await this.catalog(),
      skipped: catalog.tasks
        .filter((task) => task.disabledReason)
        .map((task) => task.name),
    };
  }
}
