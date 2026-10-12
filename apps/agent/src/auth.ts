import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AuthStore, CatalogCache } from "@oxbit/agent-core";
import { readJson, writeFileAtomic, writeJson } from "./config.js";

type AuthFile = Record<string, unknown>;
const queues = new Map<string, Promise<unknown>>();

/** Runs tasks with the same key one at a time, in call order, across all stores in this process. */
function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/** `apikey:<id>` slots that the earlier build saved as `{<id>: {type: "api", key}}`. */
const legacyId = (key: string) => /^apikey:([\w-]+)$/.exec(key)?.[1];
const legacyKey = (entry: unknown) => {
  const { type, key } = (entry ?? {}) as { type?: unknown; key?: unknown };
  return type === "api" && typeof key === "string" && key ? key : undefined;
};

/** ~/.oxbit/agent/auth.json: string entries such as `apikey:anthropic` and `chatgpt`, written atomically with mode 0600. */
export class FileAuthStore implements AuthStore {
  constructor(readonly path: string) {}
  private async read(): Promise<AuthFile> {
    const data = await readJson<unknown>(this.path, {});
    return data && typeof data === "object" && !Array.isArray(data) ? data as AuthFile : {};
  }
  /** Re-reads the file and writes it when `change` returns true, so entries from other processes survive. */
  private update(change: (data: AuthFile) => boolean) {
    return serial(`write ${this.path}`, async () => {
      const data = await this.read();
      if (change(data)) await writeJson(this.path, data, 0o600);
    });
  }
  async get(key: string) {
    const data = await this.read();
    const value = data[key];
    if (typeof value === "string") return value;
    const id = legacyId(key);
    return id ? legacyKey(data[id]) : undefined;
  }
  set(key: string, value: string) {
    return this.update((data) => {
      data[key] = value;
      const id = legacyId(key);
      if (id && legacyKey(data[id])) delete data[id];
      return true;
    });
  }
  delete(key: string) {
    return this.update((data) => {
      const id = legacyId(key);
      const legacy = !!id && !!legacyKey(data[id]);
      if (!(key in data) && !legacy) return false;
      delete data[key];
      if (legacy) delete data[id!];
      return true;
    });
  }
  /** Holds an in-process mutex on `key`. Another process can still refresh at the same time. */
  lock<T>(key: string, task: () => Promise<T>) {
    return serial(`lock ${this.path} ${key}`, task);
  }
  /** Saved entry keys; legacy API keys appear as `apikey:<id>`. */
  async keys() {
    const data = await this.read();
    return [...new Set(Object.entries(data).flatMap(([key, value]) => typeof value === "string" ? [key] : legacyKey(value) ? [`apikey:${key}`] : []))];
  }
}

/** Catalog entries as files under ~/.oxbit/agent/cache; the file's mtime is the save time. */
export class FileCatalogCache implements CatalogCache {
  constructor(readonly dir: string) {}
  private file(key: string) {
    return join(this.dir, `${key.replace(/[^\w.-]/g, "_")}.json`);
  }
  async get(key: string) {
    const file = this.file(key);
    try {
      const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      return { text, savedAt: info.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  set(key: string, text: string) {
    return writeFileAtomic(this.file(key), text);
  }
}
