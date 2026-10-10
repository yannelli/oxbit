import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentService } from "../../documents/src/index.js";
import { BrowserFileSystem, MemoryPersistence } from "../../host-browser/src/index.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@oxbit/app-workbench", () => ({ createWorkbenchSession: vi.fn() }));
vi.mock("@oxbit/feature-runtime", () => ({
  KEEP_ALIVE_SETTING: "runtime.keepAlive",
  keepAliveMs: () => 0,
}));
vi.mock("./runtime-connector.js", () => ({ DesktopRuntimeConnector: class {} }));

const { ProjectSessionManager } = await import("./index.js");
const services: DocumentService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

describe("desktop close", () => {
  it.each(["text", "encoding", "eol", "readonly"])("discards %s changes without retaining a recovery draft", async (change) => {
    const persistence = new MemoryPersistence();
    const filesystem = new BrowserFileSystem(persistence, "desktop-test");
    const saved = await filesystem.write("dirty.txt", "saved", { expectedRevision: null });
    await filesystem.write("clean.txt", "clean", { expectedRevision: null });
    const documents = new DocumentService(filesystem, persistence);
    services.push(documents);
    const document = await documents.open("dirty.txt");
    await documents.open("clean.txt");
    if (change === "encoding") document.encoding = "latin1";
    else if (change === "eol") document.eol = "CRLF";
    else document.replace("unsaved");
    if (change === "readonly") documents.setState("dirty.txt", "readonly");
    const session = {
      documents,
      persist: vi.fn(() => documents.persist()),
      dispose: vi.fn(async () => documents.dispose()),
    };
    const manager = new ProjectSessionManager();
    Object.assign(manager, { entries: new Map([["project", { session }]]) });

    await manager.commitClose(["project"], true);

    expect(session.persist).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.get("project")?.session).toBeUndefined();
    expect(await filesystem.read("dirty.txt")).toEqual(saved);
    const recovered = new DocumentService(filesystem, persistence);
    services.push(recovered);
    await recovered.restore();
    expect(recovered.get("dirty.txt")).toBeUndefined();
    expect(recovered.get("clean.txt")?.text.toString()).toBe("clean");
  });
});
