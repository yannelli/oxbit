import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createRuntime, type RuntimeOptions } from "../src/runtime.js";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
});
async function start(options: Partial<RuntimeOptions>) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-liveness-"));
  directories.push(directory);
  await fs.mkdir(path.join(directory, "workspace"));
  return createRuntime({
    root: path.join(directory, "workspace"),
    tasksHome: directory,
    dataDir: path.join(directory, "state"),
    projectsDir: path.join(directory, "projects"),
    settingsFile: path.join(directory, "settings.json"),
    pairingCode: "liveness-code",
    ...options,
  });
}
async function pairedClient(port: number, autoPong = true) {
  const { token } = await (await fetch(`http://127.0.0.1:${port}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "liveness-code" }),
  })).json();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}`, autoPong });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({ v: 1, type: "request", id: "auth", method: "auth.authenticate", params: { token } })));
    socket.on("message", (bytes) => { if (JSON.parse(bytes.toString()).id === "auth") resolve(); });
  });
  return socket;
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("idle shutdown", () => {
  it("calls onIdle after the last authenticated client has been gone for afterMs", async () => {
    let idleAt = 0;
    const started = Date.now();
    const runtime = await start({ idleShutdown: { afterMs: 300, onIdle: () => { idleAt = Date.now(); } } });
    try {
      const socket = await pairedClient(runtime.port);
      expect(runtime.idleSince()).toBeUndefined();
      await delay(500);
      expect(idleAt).toBe(0);
      const left = Date.now();
      socket.close();
      await new Promise((resolve) => socket.once("close", resolve));
      await delay(150);
      expect(runtime.idleSince()).toBeGreaterThanOrEqual(left - 50);
      expect(idleAt).toBe(0);
      await delay(400);
      expect(idleAt).toBeGreaterThanOrEqual(left + 250);
      expect(idleAt - started).toBeGreaterThan(700);
    } finally {
      await runtime.close();
    }
  });
});

describe("WebSocket ping", () => {
  it("terminates a client that misses a pong and keeps one that answers", async () => {
    const runtime = await start({ pingIntervalMs: 100 });
    try {
      const silent = await pairedClient(runtime.port, false);
      const answering = await pairedClient(runtime.port);
      const closed = new Promise<number>((resolve) => silent.once("close", resolve));
      expect(await closed).toBe(1006);
      await delay(300);
      expect(answering.readyState).toBe(WebSocket.OPEN);
      answering.close();
    } finally {
      await runtime.close();
    }
  });
});
