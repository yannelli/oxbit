import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateX25519KeyPair, parseOfferLink, type TunnelSession } from "@oxbit/sdk/tunnel";
import { createRuntime } from "../src/runtime.js";
import { writeRecord, type Daemon } from "../src/daemon.js";
import { connectDevice } from "./remote-device.js";
import { RemoteHost } from "../src/remote/host.js";
import { cliLauncher } from "../src/remote/runtimes.js";
import { readProjects, remotePaths } from "../src/remote/state.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Next text message on `stream` whose JSON has `id`. */
function reply(session: TunnelSession, stream: number, id: string) {
  return new Promise<any>((resolve) => {
    const off = session.on("message", (from, text) => {
      const message = JSON.parse(text);
      if (from !== stream || message.id !== id) return;
      off();
      resolve(message);
    });
  });
}

describe("host.open", () => {
  it("starts a folder runtime once, pairs with it, and forwards runtime messages over a stream", async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxr-open-")));
    cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
    const home = path.join(directory, "home");
    const workspace = path.join(home, "Projects", "app");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "# app\n");
    const runtimes: Array<Awaited<ReturnType<typeof createRuntime>>> = [];
    cleanup.push(() => Promise.all(runtimes.map((runtime) => runtime.close())));
    let starts = 0;
    const launcher = cliLauncher(home, async (root, dataDir) => {
      starts++;
      const runtime = await createRuntime({
        root,
        dataDir,
        port: 0,
        host: "127.0.0.1",
        tasksHome: directory,
        projectsDir: path.join(directory, "projects"),
        settingsFile: path.join(directory, "settings.json"),
      });
      runtimes.push(runtime);
      const daemon: Daemon = { id: runtime.identity.id, pid: process.pid, host: "127.0.0.1", port: runtime.port, pairingCode: runtime.pairingCode, root: runtime.root, startedAt: Date.now() };
      await writeRecord(dataDir, daemon);
      return daemon;
    });
    const paths = remotePaths({ OXBIT_REMOTE_DIR: path.join(directory, "remote") });
    const host = await RemoteHost.start({ paths, home, env: {}, launcher, advertise: false, relay: false, ipc: false, lanHost: "127.0.0.1", name: "Studio Mac" });
    cleanup.push(() => host.close());
    const offer = await parseOfferLink((await host.createOffer()).link);
    const device = await connectDevice(`ws://127.0.0.1:${host.status().lan.port}/v1/connect`, { deviceKey: await generateX25519KeyPair(), name: "iPhone", offer });
    cleanup.push(async () => device.socket.close());
    const { control, session } = device;

    await expect(control.request("host.open", { path: "~/.ssh" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(control.request("host.open", { path: "~/Projects/app/README.md" })).rejects.toMatchObject({ code: "NOT_A_DIRECTORY" });

    const opened = await control.request<any>("host.open", { path: "~/Projects/app" });
    expect(opened).toEqual({
      stream: 1,
      token: expect.any(String),
      runtime: { id: runtimes[0]!.identity.id, name: os.hostname(), version: expect.any(String) },
      workspace: { root: workspace, name: "app" },
    });
    const authenticated = reply(session, opened.stream, "auth");
    await session.send(opened.stream, JSON.stringify({ v: 1, type: "request", id: "auth", method: "auth.authenticate", params: { token: opened.token } }));
    expect((await authenticated).result).toMatchObject({ owner: true, runtime: { id: opened.runtime.id } });
    const listed = reply(session, opened.stream, "list");
    await session.send(opened.stream, JSON.stringify({ v: 1, type: "request", id: "list", method: "fs.list", params: { path: "" } }));
    expect((await listed).result).toEqual(expect.arrayContaining([expect.objectContaining({ name: "README.md" })]));

    const second = await control.request<any>("host.open", { path: workspace });
    expect(second).toMatchObject({ stream: 2, token: opened.token, runtime: opened.runtime });
    expect(starts).toBe(1);

    expect(await control.request("host.projects")).toEqual({ projects: [{ path: workspace, name: "app", running: true, lastOpened: expect.any(Number) }] });
    await expect.poll(() => readProjects(paths)).toEqual([{ path: workspace, lastOpened: expect.any(Number) }]);

    const events: unknown[] = [];
    control.on("stream.closed", (params) => events.push(params));
    const streamEnded = new Promise((resolve) => session.on("streamClosed", (stream, reason) => resolve([stream, reason])));
    expect(await control.request("host.close", { stream: 2 })).toEqual({});
    expect(await streamEnded).toEqual([2, "closed"]);
    await expect.poll(() => events).toEqual([{ stream: 2, reason: "closed" }]);

    await runtimes[0]!.close();
    await expect.poll(() => events.length).toBe(2);
    expect(events[1]).toMatchObject({ stream: 1, reason: expect.any(String) });
    expect(await control.request("host.projects")).toEqual({ projects: [{ path: workspace, name: "app", running: false, lastOpened: expect.any(Number) }] });
  });
});
