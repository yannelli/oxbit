import { pathToFileURL } from "node:url";
import { createKernel } from "@oxbit/core";
import type { FileChange, FileSystem } from "@oxbit/sdk";
import { RpcError } from "@oxbit/protocol";
import { WorkspaceFiles } from "./filesystem.js";

export class RuntimeExtensions {
  readonly kernel = createKernel({ environment: "runtime" });
  private watchers = new Set<(change: FileChange) => void>();
  constructor(
    private files: WorkspaceFiles,
    services: Record<string, unknown> = {},
  ) {
    const filesystem: FileSystem = {
      id: "runtime:default",
      list: (path) => files.list(path),
      read: (path) => files.read(path),
      write: (path, text, options) => files.write(path, text, options),
      mkdir: (path) => files.mkdir(path),
      rename: (path, to) => files.rename(path, to),
      delete: (path) => files.delete(path),
      watch: (listener) => {
        this.watchers.add(listener);
        return {
          dispose: () => {
            this.watchers.delete(listener);
          },
        };
      },
    };
    this.kernel.services.register("filesystem", filesystem);
    this.kernel.services.register("runtime.workspace", {
      id: "default",
      root: files.root,
    });
    for (const [name, service] of Object.entries(services))
      this.kernel.services.register(name, service);
  }
  async load(relative: string) {
    const full = await this.files.resolve(relative);
    if (!/\.(?:mjs|js|ts|mts)$/.test(full))
      throw new RpcError(
        "INVALID_PARAMS",
        "Runtime extensions require a JavaScript ESM or erasable TypeScript artifact",
      );
    return { id: await this.kernel.extensions.load(pathToFileURL(full).href) };
  }
  async update(relative: string) {
    const full = await this.files.resolve(relative);
    if (!/\.(?:mjs|js|ts|mts)$/.test(full))
      throw new RpcError(
        "INVALID_PARAMS",
        "Runtime extensions require a JavaScript ESM or erasable TypeScript artifact",
      );
    const artifact = await import(
      /* @vite-ignore */ `${pathToFileURL(full).href}?updated=${Date.now()}`
    );
    const extension = artifact.default ?? artifact.extension;
    await this.kernel.extensions.update(extension);
    return { id: extension.manifest.id };
  }
  list() {
    return this.kernel.extensions.list();
  }
  async disable(id: string) {
    await this.kernel.extensions.disable(id);
    return { ok: true };
  }
  async activate(id: string) {
    await this.kernel.extensions.activate(id);
    return { ok: true };
  }
  async remove(id: string) {
    await this.kernel.extensions.remove(id);
    return { ok: true };
  }
  async suspend() {
    for (const extension of this.list())
      if (extension.state === "active" || extension.state === "activating")
        await this.kernel.extensions.disable(extension.manifest.id);
  }
  changed(change: FileChange) {
    for (const listener of this.watchers)
      try {
        listener(change);
      } catch (error) {
        console.error(error);
      }
  }
  dispose() {
    this.kernel.dispose();
    this.watchers.clear();
  }
}
