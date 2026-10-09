import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { isRuntimeIdentity } from "@oxbit/protocol";
import { createRuntime } from "../src/runtime.js";
import { runtimeVersion } from "../src/version.js";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
});
async function workspace() {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-identity-"));
  directories.push(directory);
  await fs.mkdir(path.join(directory, "workspace"));
  return directory;
}
const start = (directory: string) =>
  createRuntime({
    root: path.join(directory, "workspace"),
    tasksHome: directory,
    dataDir: path.join(directory, "state"),
    projectsDir: path.join(directory, "projects"),
    settingsFile: path.join(directory, "settings.json"),
    pairingCode: "identity-code",
  });
function authenticate(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  return new Promise<any>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({ v: 1, type: "request", id: "auth", method: "auth.authenticate", params: { token } })));
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.id !== "auth") return;
      socket.close();
      if (message.error) reject(message.error);
      else resolve(message.result);
    });
  });
}

describe("runtime identity", () => {
  it("binds an OS-assigned port and keeps its id across restarts", async () => {
    const directory = await workspace();
    const first = await start(directory);
    await first.close();
    const second = await start(directory);
    try {
      expect(first.port).toBeGreaterThan(0);
      expect(isRuntimeIdentity(first.identity)).toBe(true);
      expect(second.identity.id).toBe(first.identity.id);
      expect(second.identity).toMatchObject({ name: os.hostname(), version: runtimeVersion() });
      expect(runtimeVersion()).toMatch(/^\d+\.\d+\.\d+/);
      const state = JSON.parse(await fs.readFile(path.join(directory, "state", "runtime.json"), "utf8"));
      expect(state.id).toBe(first.identity.id);
    } finally {
      await second.close();
    }
  });

  it("serves the identity from health, pairing, and authentication", async () => {
    const runtime = await start(await workspace());
    try {
      const base = `http://127.0.0.1:${runtime.port}`;
      const health = await (await fetch(`${base}/api/health`)).json();
      expect(health).toEqual({ ok: true, protocol: 1, ...runtime.identity });
      expect(health.startedAt).toBeGreaterThan(0);
      const pair = await (await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "identity-code" }),
      })).json();
      expect(pair.runtime).toEqual(runtime.identity);
      expect((await authenticate(runtime.port, pair.token)).runtime).toEqual(runtime.identity);
    } finally {
      await runtime.close();
    }
  });
});
