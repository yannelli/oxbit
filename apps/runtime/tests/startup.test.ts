import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RpcError } from "@oxbit/protocol";

const watchers: FakeWatcher[] = [];
class FakeWatcher extends EventEmitter {
  closed = false;
  add() { return this; }
  async close() { this.closed = true; }
}
// The settings store watches named paths and needs "ready"; the workspace watcher starts empty and never scans.
vi.mock("chokidar", () => ({
  default: {
    watch: (paths: string[]) => {
      const watcher = new FakeWatcher();
      if (paths.length) setImmediate(() => watcher.emit("ready"));
      else watchers.push(watcher);
      return watcher;
    },
  },
}));
const { createRuntime } = await import("../src/runtime.js");
const { Processes } = await import("../src/processes.js");
const { nodeVersionError } = await import("../src/node-version.js");

const directories: string[] = [];
async function start() {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-startup-"));
  directories.push(directory);
  await fs.mkdir(path.join(directory, "workspace"));
  return createRuntime({
    root: path.join(directory, "workspace"),
    tasksHome: directory,
    port: 0,
    dataDir: path.join(directory, "state"),
    projectsDir: path.join(directory, "projects"),
    settingsFile: path.join(directory, "settings.json"),
  });
}
afterEach(async () => {
  watchers.length = 0;
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("startup", () => {
  it("answers health while the first watcher scan is still running", async () => {
    const runtime = await start();
    let ready = false;
    void runtime.watcherReady.then(() => { ready = true; });
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, protocol: 1 });
    expect(ready).toBe(false);
    await runtime.close();
    expect(watchers[0]!.closed).toBe(true);
  });

  it("logs a watcher error after listening and keeps serving", async () => {
    const runtime = await start();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      watchers[0]!.emit("error", Object.assign(new Error("watch broke"), { code: "EIO" }));
      await runtime.watcherReady;
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("EIO watch broke"));
    } finally {
      stderr.mockRestore();
    }
    expect((await fetch(`http://127.0.0.1:${runtime.port}/api/health`)).status).toBe(200);
    await runtime.close();
  });
});

describe("terminal module loading", () => {
  it("reports a node-pty load failure as an RpcError", async () => {
    const processes = new Processes(os.tmpdir(), () => {}, () => Promise.reject(new Error("dlopen failed: wrong ABI")));
    const failure = await processes.create("owner", "connection").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcError);
    expect((failure as RpcError).message).toBe("node-pty failed to load: dlopen failed: wrong ABI");
  });
});

describe("node version", () => {
  it("names the found and required versions below Node 24", () => {
    expect(nodeVersionError("22.11.0")).toContain("found Node.js 22.11.0");
    expect(nodeVersionError("22.11.0")).toContain("Node.js 24");
    expect(nodeVersionError("24.0.0")).toBeUndefined();
  });
});
