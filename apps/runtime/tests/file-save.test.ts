import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { MAX_FILE_BYTES, MAX_FILE_WRITE_MESSAGE_BYTES, operationId } from "@oxbit/protocol";
import type { FileSnapshot } from "@oxbit/sdk";
import { RuntimeClient, RuntimeFileSystem } from "../../../packages/host-runtime/src/index.js";
import { createRuntime } from "../src/runtime.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

it("saves text above 2 MiB and at the file limit through the host and runtime", async () => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-file-save-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  const options = { root, tasksHome: directory, dataDir: path.join(directory, "state"), projectsDir: path.join(directory, "projects"), settingsFile: path.join(directory, "settings.json") };
  const runtime = await createRuntime(options);
  cleanup.push(() => runtime.close());
  const url = `http://127.0.0.1:${runtime.port}`;
  class RuntimeSocket extends WebSocket {
    constructor(address: string) { super(address, { origin: new URL(address).origin.replace(/^ws/, "http"), maxPayload: MAX_FILE_WRITE_MESSAGE_BYTES }); }
  }
  vi.stubGlobal("WebSocket", RuntimeSocket);
  const client = new RuntimeClient(url, "default", { persistToken: false });
  cleanup.push(() => client.dispose());
  const session = await client.pair(runtime.pairingCode);
  await client.connect();
  const files = new RuntimeFileSystem(client);
  const initial = "x".repeat(3 * 1024 * 1024);
  await fs.writeFile(path.join(root, "large.txt"), initial);
  const read = await files.read("large.txt");
  const saved = await files.write("large.txt", initial + "edited", { expectedRevision: read.revision });
  expect(await fs.readFile(path.join(root, "large.txt"), "utf8")).toBe(initial + "edited");
  expect(saved.revision).not.toBe(read.revision);

  await fs.writeFile(path.join(root, "shared.txt"), initial);
  const room = await client.request<{ update: string; revision: string }>("collab.join", { path: "shared.txt" });
  const shared = new Y.Doc();
  try {
    Y.applyUpdate(shared, Buffer.from(room.update, "base64"));
    shared.getText("content").insert(0, "shared ");
    await client.request("collab.update", { path: "shared.txt", update: Buffer.from(Y.encodeStateAsUpdate(shared)).toString("base64") });
    const sharedId = client.createOperationId();
    expect(await client.request("collab.save", { path: "shared.txt", text: shared.getText("content").toString(), expectedRevision: room.revision }, { id: sharedId })).toMatchObject({ text: "shared " + initial });
    expect(await client.request("operation.status", { id: sharedId })).toMatchObject({ status: "completed", resultExpired: true });
  } finally { shared.destroy(); }

  const boundary = "\u0001".repeat(1024 * 1024) + "x".repeat(MAX_FILE_BYTES - 1024 * 1024);
  const largeId = client.createOperationId();
  const atLimit = await client.request<FileSnapshot>("fs.write", { path: "large.txt", text: boundary, expectedRevision: saved.revision }, { id: largeId });
  expect(atLimit.text).toBe(boundary);
  expect((await fs.stat(path.join(root, "large.txt"))).size).toBe(MAX_FILE_BYTES);
  await expect(files.write("large.txt", boundary + "x", { expectedRevision: atLimit.revision })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  expect(await client.request("operation.status", { id: largeId })).toMatchObject({ status: "completed", resultExpired: true });
  await expect(client.request("fs.write", { path: "large.txt", text: "duplicate", expectedRevision: atLimit.revision }, { id: largeId })).rejects.toMatchObject({ code: "OPERATION_RESULT_EXPIRED" });
  expect((await fs.stat(path.join(root, "large.txt"))).size).toBe(MAX_FILE_BYTES);

  const smallId = client.createOperationId();
  const small = await client.request("fs.write", { path: "once.txt", text: "once", expectedRevision: null }, { id: smallId });
  expect(await client.request("fs.write", { path: "once.txt", text: "duplicate", expectedRevision: null }, { id: smallId })).toEqual(small);
  client.disconnect();
  await runtime.close();
  const restarted = await createRuntime(options);
  cleanup.push(() => restarted.close());
  const recovered = new RuntimeClient(`http://127.0.0.1:${restarted.port}`, "default", { token: session!.token, persistToken: false });
  cleanup.push(() => recovered.dispose());
  await recovered.connect();
  expect(await recovered.request("fs.write", { path: "once.txt", text: "after restart", expectedRevision: null }, { id: smallId })).toEqual(small);
  expect(await fs.readFile(path.join(root, "once.txt"), "utf8")).toBe("once");
  expect(await recovered.request("operation.status", { id: largeId })).toMatchObject({ status: "completed", resultExpired: true });
  await expect(recovered.request("fs.write", { path: "large.txt", text: "after restart", expectedRevision: atLimit.revision }, { id: largeId })).rejects.toMatchObject({ code: "OPERATION_RESULT_EXPIRED" });
  const retiredId = operationId(randomUUID(), randomUUID());
  expect(await recovered.request("operation.status", { id: retiredId })).toMatchObject({ status: "expired" });
  await expect(recovered.request("fs.write", { path: "once.txt", text: "expired", expectedRevision: null }, { id: retiredId })).rejects.toMatchObject({ code: "OPERATION_EXPIRED" });
  expect((await fs.stat(path.join(options.dataDir, "runtime.json"))).size).toBeLessThan(2 * 1024 * 1024);
}, 30000);
