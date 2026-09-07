import type { FeatureOptions, DocumentEdit } from "@oxbit/sdk";
import {
  matcher,
  replaceMatch,
  globMatch,
  type SearchMatch,
  type SearchOptions,
} from "./engine";
type SearchFile = {
  path: string;
  text: string;
  revision: string;
  version?: number;
};
const resultLimit = 10000;
export class SearchService {
  warnings: string[] = [];
  truncated = false;
  private searches = new Set<AbortController>();
  constructor(private o: FeatureOptions) {}
  async search(
    options: SearchOptions,
    signal?: AbortSignal,
  ): Promise<SearchMatch[]> {
    matcher(options);
    const controller = new AbortController();
    this.searches.add(controller);
    const cancellation = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    this.warnings = [];
    this.truncated = false;
    let worker: Worker | undefined;
    const searchFiles = async (files: SearchFile[]): Promise<SearchMatch[]> => {
      cancellation.throwIfAborted();
      worker ??= new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      return new Promise((resolve, reject) => {
        const cleanup = () => cancellation.removeEventListener("abort", cancel);
        const cancel = () => {
          cleanup();
          reject(
            cancellation.reason ??
              new DOMException("Search cancelled", "AbortError"),
          );
        };
        cancellation.addEventListener("abort", cancel, { once: true });
        worker!.onmessage = (event) => {
          cleanup();
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.results);
        };
        worker!.onerror = (event) => {
          cleanup();
          reject(new Error(event.message));
        };
        worker!.postMessage({ id: crypto.randomUUID(), files, options });
      });
    };
    try {
      cancellation.throwIfAborted();
      let matches: SearchMatch[] = [];
      if (this.o.runtime?.connected) {
        const result = await this.o.runtime.request<any>(
          "search.query",
          { ...options },
          { signal: cancellation },
        );
        matches = Array.isArray(result) ? result : (result.matches ?? []);
        this.truncated = result.truncated === true;
      } else {
        let batch: SearchFile[] = [];
        let bytes = 0;
        const flush = async () => {
          if (!batch.length) return;
          matches.push(
            ...(await searchFiles(batch)).slice(
              0,
              resultLimit - matches.length,
            ),
          );
          batch = [];
          bytes = 0;
        };
        const walk = async (path = "") => {
          for (const entry of await this.o.filesystem.list(path)) {
            cancellation.throwIfAborted();
            if (matches.length >= resultLimit) {
              this.truncated = true;
              return;
            }
            if (entry.kind === "directory") {
              if (
                [".git", "node_modules"].includes(entry.path.split("/").at(-1)!)
              )
                continue;
              await walk(entry.path);
            } else {
              if (
                !globMatch(entry.path, options.include) ||
                (options.exclude?.trim() &&
                  globMatch(entry.path, options.exclude))
              )
                continue;
              try {
                if (entry.size && entry.size > 20 * 1024 * 1024)
                  throw new Error("File exceeds the 20 MiB search limit");
                const doc = this.o.documents.get(entry.path);
                const snapshot = doc
                  ? { text: doc.text.toString(), revision: doc.savedRevision }
                  : await this.o.filesystem.read(entry.path);
                batch.push({
                  path: entry.path,
                  text: snapshot.text,
                  revision: snapshot.revision,
                  version: doc?.version,
                });
                bytes += snapshot.text.length * 2;
                if (batch.length >= 64 || bytes >= 4 * 1024 * 1024)
                  await flush();
              } catch (error) {
                cancellation.throwIfAborted();
                this.warnings.push(`${entry.path}: ${String(error)}`);
              }
            }
          }
        };
        await walk();
        await flush();
      }
      for (const doc of this.o.documents.documents.values()) {
        if (!doc.dirty) continue;
        matches = matches.filter((match) => match.path !== doc.path);
        matches.push(
          ...(await searchFiles([
            {
              path: doc.path,
              text: doc.text.toString(),
              revision: doc.savedRevision,
              version: doc.version,
            },
          ])),
        );
      }
      cancellation.throwIfAborted();
      this.truncated ||= matches.length >= resultLimit;
      return matches
        .sort((a, b) => a.path.localeCompare(b.path) || a.from - b.from)
        .slice(0, resultLimit);
    } finally {
      worker?.terminate();
      this.searches.delete(controller);
    }
  }
  async preview(
    matches: SearchMatch[],
    options: SearchOptions,
    replacement: string,
  ) {
    const result: SearchMatch[] = [];
    for (const path of new Set(matches.map((match) => match.path))) {
      const doc = await this.o.documents.open(path);
      for (const match of matches.filter((match) => match.path === path)) {
        if (
          match.revision !== doc.savedRevision ||
          (match.version !== undefined && match.version !== doc.version)
        )
          throw new Error(`${path} changed; search again`);
        result.push({
          ...match,
          version: doc.version,
          replacement: replaceMatch(
            doc.text.toString(),
            match.from,
            match.to,
            options,
            replacement,
          ),
        });
      }
    }
    return result;
  }
  async apply(matches: SearchMatch[]) {
    const failures: { path: string; error: string }[] = [];
    let applied = 0;
    for (const path of new Set(matches.map((match) => match.path))) {
      try {
        const items = matches.filter((match) => match.path === path);
        const edit: DocumentEdit = {
          path,
          expectedVersion: items[0].version,
          expectedRevision: items[0].revision,
          edits: items.map((match) => ({
            from: match.from,
            to: match.to,
            insert: match.replacement ?? "",
          })),
        };
        await this.o.documents.applyEdits([edit]);
        applied++;
      } catch (error) {
        failures.push({ path, error: String(error) });
      }
    }
    return { applied, failures };
  }
  dispose() {
    for (const controller of this.searches) controller.abort();
    this.searches.clear();
  }
}
