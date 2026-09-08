import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { FileSnapshot } from "@oxbit/sdk";
import { createKernel } from "../../core/src/index";
import {
  BrowserFileSystem,
  MemoryPersistence,
} from "../../host-browser/src/index";
import {
  DocumentHandle,
  DocumentService,
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
} from "./index";

const services: DocumentService[] = [];
const handles: DocumentHandle[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const handle of handles.splice(0)) handle.dispose();
});
const setup = async () => {
  const persistence = new MemoryPersistence();
  const filesystem = new BrowserFileSystem(persistence);
  await filesystem.write("index.ts", "const value = 1;\n", {
    expectedRevision: null,
  });
  const service = new DocumentService(filesystem, persistence);
  services.push(service);
  return { persistence, filesystem, service };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("shared documents", () => {
  it("saves an explicitly reviewed snapshot exactly while ordinary saves retain hooks", async () => {
    const { filesystem, persistence } = await setup();
    const kernel = createKernel({ environment: "browser" });
    const service = new DocumentService(filesystem, persistence, kernel);
    services.push(service);
    kernel.hooks.beforeSave("format", ({ text }) => text + " formatted");
    const document = await service.open("index.ts");
    document.replace("reviewed snapshot");
    await service.save("index.ts", undefined, { skipHooks: true });
    expect((await filesystem.read("index.ts")).text).toBe("reviewed snapshot");
    expect(document.dirty).toBe(false);
    document.replace("ordinary save");
    await service.save("index.ts");
    expect((await filesystem.read("index.ts")).text).toBe(
      "ordinary save formatted",
    );
    kernel.dispose();
  });
  it("recovers unsaved Yjs content with stable IDs and independent view state", async () => {
    const { service, filesystem, persistence } = await setup();
    const document = await service.open("index.ts");
    document.replace('const value = "unsaved";\n');
    document.views.set("left", { anchor: 2, head: 3, scrollTop: 10 });
    document.views.set("right", { anchor: 8, head: 8, scrollTop: 90 });
    await service.persist();
    const recovered = new DocumentService(filesystem, persistence);
    services.push(recovered);
    await recovered.restore();
    const restored = recovered.get("index.ts")!;
    expect(restored.id).toBe(document.id);
    expect(restored.text.toString()).toBe(document.text.toString());
    expect(restored.dirty).toBe(true);
    expect(restored.views.get("left")?.scrollTop).toBe(10);
    expect(restored.views.get("right")?.anchor).toBe(8);
    await recovered.save("index.ts");
    expect((await filesystem.read("index.ts")).text).toBe(
      'const value = "unsaved";\n',
    );
    expect(restored.dirty).toBe(false);
  });
  it("detects external changes and preserves local recovery text", async () => {
    const { service, filesystem } = await setup();
    const document = await service.open("index.ts");
    document.replace("local");
    const disk = await filesystem.read("index.ts");
    await filesystem.write("index.ts", "external", {
      expectedRevision: disk.revision,
    });
    await tick();
    expect(document.state).toBe("conflict");
    expect(document.text.toString()).toBe("local");
    await expect(service.save("index.ts")).rejects.toThrow("Resolve");
    await service.reload("index.ts");
    expect(document.text.toString()).toBe("external");
    expect(document.dirty).toBe(false);
    await filesystem.delete("index.ts");
    await tick();
    expect(document.state).toBe("missing");
    expect(document.text.toString()).toBe("external");
  });
  it("rejects stale multi-file edits before changing any text", async () => {
    const { service, filesystem } = await setup();
    await filesystem.write("second.ts", "second", { expectedRevision: null });
    const first = await service.open("index.ts");
    const second = await service.open("second.ts");
    second.replace("newer");
    await expect(
      service.applyEdits([
        {
          path: first.path,
          expectedVersion: first.version,
          edits: [{ from: 0, to: 5, insert: "let" }],
        },
        {
          path: second.path,
          expectedVersion: 0,
          edits: [{ from: 0, to: 1, insert: "S" }],
        },
      ]),
    ).rejects.toThrow("Stale");
    expect(first.text.toString()).toBe("const value = 1;\n");
    expect(second.text.toString()).toBe("newer");
  });
  it("keeps edits made during an awaited disk write dirty", async () => {
    const { service, filesystem } = await setup();
    const document = await service.open("index.ts");
    document.replace("submitted");
    const write = filesystem.write.bind(filesystem);
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    filesystem.write = async (...args) => {
      started();
      await barrier;
      return write(...args);
    };
    const save = service.save("index.ts");
    await writing;
    document.replace("typed during save");
    release();
    await save;
    expect(document.savedText).toBe("submitted");
    expect(document.text.toString()).toBe("typed during save");
    expect(document.dirty).toBe(true);
  });
  it("rejects edits made while asynchronous save hooks run", async () => {
    const { filesystem, persistence } = await setup();
    const kernel = createKernel();
    const service = new DocumentService(filesystem, persistence, kernel);
    services.push(service);
    const document = await service.open("index.ts");
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    kernel.hooks.beforeSave("format", async ({ text }) => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return text.toUpperCase();
    });
    const save = service.save("index.ts");
    await ready;
    document.replace("newer user edit");
    release();
    await expect(save).rejects.toThrow("changed while save hooks");
    expect(document.text.toString()).toBe("newer user edit");
    kernel.dispose();
  });
  it("merges two offline peers and keeps remote text when undoing local edits", () => {
    const server = new Y.Doc();
    server.getText("content").insert(0, "base");
    const sharedUpdate = btoa(
      String.fromCharCode(...Y.encodeStateAsUpdate(server)),
    );
    const snapshot: FileSnapshot = {
      path: "shared.ts",
      text: "base",
      revision: "disk-1",
      encoding: "utf-8",
      eol: "LF",
      sharedUpdate,
    };
    const first = new DocumentHandle("a", "shared.ts", snapshot);
    const second = new DocumentHandle("b", "shared.ts", snapshot);
    handles.push(first, second);
    first.transact([{ from: 4, to: 4, insert: " FIRST" }], LOCAL_ORIGIN);
    second.transact([{ from: 0, to: 0, insert: "SECOND " }], LOCAL_ORIGIN);
    Y.applyUpdate(
      first.ydoc,
      Y.encodeStateAsUpdate(second.ydoc),
      REMOTE_ORIGIN,
    );
    Y.applyUpdate(
      second.ydoc,
      Y.encodeStateAsUpdate(first.ydoc),
      REMOTE_ORIGIN,
    );
    expect(first.text.toString()).toBe(second.text.toString());
    expect(first.text.toString()).toBe("SECOND base FIRST");
    first.undo.undo();
    expect(first.text.toString()).toBe("SECOND base");
    server.destroy();
  });
  it("merges recovery and server Yjs state without duplicating seed text", async () => {
    const persistence = new MemoryPersistence();
    const filesystem = new BrowserFileSystem(persistence);
    await filesystem.write("shared.ts", "seed", { expectedRevision: null });
    const server = new Y.Doc();
    server.getText("content").insert(0, "seed");
    const read = filesystem.read.bind(filesystem);
    filesystem.read = async (path) => ({
      ...(await read(path)),
      sharedUpdate: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(server))),
    });
    const service = new DocumentService(filesystem, persistence);
    services.push(service);
    const document = await service.open("shared.ts");
    document.transact([{ from: 4, to: 4, insert: " local" }]);
    await service.persist();
    server.getText("content").insert(0, "remote ");
    const restored = new DocumentService(filesystem, persistence);
    services.push(restored);
    await restored.restore();
    expect(restored.get("shared.ts")?.text.toString()).toBe(
      "remote seed local",
    );
    server.destroy();
  });
  it("preserves document identity on rename and rejects closing unsaved content", async () => {
    const { service } = await setup();
    const document = await service.open("index.ts");
    document.replace("unsaved");
    expect(() => service.close("index.ts")).toThrow("Save or discard");
    await service.applyEdits(
      [],
      [{ kind: "rename", path: "index.ts", to: "renamed.ts" }],
    );
    expect(service.get("renamed.ts")?.id).toBe(document.id);
    expect(service.get("renamed.ts")?.dirty).toBe(true);
  });
  it("shares identity across normalized paths and directory renames, including closed files", async () => {
    const { service, filesystem } = await setup();
    const first = await service.open("./index.ts");
    expect(await service.open("index.ts")).toBe(first);
    await filesystem.write("src/open.ts", "open", { expectedRevision: null });
    await filesystem.write("src/closed.ts", "closed", {
      expectedRevision: null,
    });
    const open = await service.open("src/open.ts"),
      closed = await service.open("src/closed.ts");
    const closedId = closed.id;
    service.close(closed.path);
    open.replace("unsaved");
    await service.applyEdits(
      [],
      [{ kind: "rename", path: "./src", to: "lib" }],
    );
    expect(service.get("lib/open.ts")).toBe(open);
    expect(open.dirty).toBe(true);
    expect(open.state).toBe("ready");
    expect((await service.open("lib/closed.ts")).id).toBe(closedId);
    await filesystem.write("src/closed.ts", "replacement", {
      expectedRevision: null,
    });
    expect((await service.open("src/closed.ts")).id).not.toBe(closedId);
  });
  it("rejects deleting a directory with dirty descendants before changing the filesystem", async () => {
    const { service, filesystem } = await setup();
    await filesystem.write("src/file.ts", "disk", { expectedRevision: null });
    const document = await service.open("src/file.ts");
    document.replace("local");
    await expect(
      service.applyEdits([], [{ kind: "delete", path: "src" }]),
    ).rejects.toThrow("Save changes before deleting");
    expect((await filesystem.read("src/file.ts")).text).toBe("disk");
    expect(document.text.toString()).toBe("local");
  });
  it("reloads actual disk content when shared reads expose the room's saved baseline", async () => {
    const { service, filesystem } = await setup();
    const original = await filesystem.read("index.ts");
    const read = filesystem.read.bind(filesystem);
    filesystem.read = async (path) =>
      path === "index.ts" ? original : read(path);
    (filesystem as typeof filesystem & { readDisk: typeof read }).readDisk =
      read;
    const document = await service.open("index.ts");
    document.replace("local");
    await filesystem.write("index.ts", "external", {
      expectedRevision: original.revision,
    });
    await tick();
    expect(document.state).toBe("conflict");
    await service.reload("index.ts");
    expect(document.text.toString()).toBe("external");
    expect(document.dirty).toBe(false);
  });
  it("keeps cancellation out of document error state", async () => {
    const { filesystem, persistence } = await setup();
    const kernel = createKernel();
    const service = new DocumentService(filesystem, persistence, kernel);
    services.push(service);
    const document = await service.open("index.ts");
    document.replace("local");
    kernel.hooks.beforeSave("cancel", () => {
      throw new DOMException("Cancelled", "AbortError");
    });
    await expect(service.save("index.ts")).rejects.toThrow("Cancelled");
    expect(document.state).toBe("ready");
    expect(document.dirty).toBe(true);
    kernel.dispose();
  });
});
