import { afterEach, describe, expect, it, vi } from "vitest";
import type { Extension } from "@oxbit/sdk";
import type { RuntimeClient } from "@oxbit/host-runtime";
import { BrowserFileSystem, MemoryPersistence } from "@oxbit/host-browser";

const feature = (name: string): Extension => ({
  manifest: {
    manifestVersion: 1, id: "test." + name, name, version: "1.0.0", sdk: "^1.0.0",
    environments: ["browser"], activation: [], capabilities: [],
  },
  activate() {},
});
for (const name of [
  "editor", "explorer", "settings", "runtime", "extensions", "keymaps", "search",
  "previews", "images", "terminal", "tasks", "git", "collaboration", "agent-acp",
])
  vi.doMock("@oxbit/feature-" + name, () => ({ createFeature: () => feature(name) }));
vi.doMock("@oxbit/feature-formatters", () => ({
  createFeature: () => feature("formatters"),
  createPrettierFeature: () => feature("prettier"),
  createTypeScriptFormatterFeature: () => feature("typescript-formatter"),
}));
vi.doMock("@oxbit/feature-language", () => ({
  createFeature: () => feature("language"),
  registerManagedServerFeatures: async () => {},
}));
vi.doMock("@oxbit/feature-themes", () => ({
  createFeature: () => feature("themes"),
  createVSCodeFeature: () => feature("vscode"),
  createVSCodeHighContrastFeature: () => feature("high-contrast"),
  createClassicOS98Feature: () => feature("classic"),
  classicOS98IconPack: { id: "classic", revision: "1", enabled: true },
  rainbowIconPack: { id: "rainbow", revision: "1", enabled: true },
  keepClassicOS98ForSavedTheme: async () => {},
}));
vi.doMock("@oxbit/bundle-inspector", () => ({ default: feature("inspector") }));
vi.doMock("@oxbit/ui", () => ({ translate: (text: string) => text }));
vi.doMock("@oxbit/workbench", () => ({
  RUNTIME_CONNECTOR_SERVICE: "runtimeConnector",
  createWorkbenchFeature: () => feature("workbench"),
  WorkbenchController: class {
    state = { groups: [{ tabs: [{ path: "index.ts" }] }], files: [] };
    documentChanged = vi.fn();
    notify = vi.fn();
    touch = vi.fn();
    restore = vi.fn(async () => {});
    persist = vi.fn(async () => {});
    dispose = vi.fn();
    set(patch: object) { Object.assign(this.state, patch); }
  },
}));

const { createWorkbenchSession } = await import("./index.js");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session disposal", () => {
  it("keeps subscriptions and unload protection after persistence fails, then disposes on retry", async () => {
    const browserWindow = new EventTarget(), browserDocument = new EventTarget();
    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("document", browserDocument);
    const persistence = new MemoryPersistence();
    const filesystem = new BrowserFileSystem(persistence, "session-test");
    await filesystem.write("index.ts", "saved", { expectedRevision: null });
    const listeners = new Map<string, Set<(value: Record<string, unknown>) => void>>();
    const runtime = {
      connected: true,
      session: { owner: false, trusted: false },
      subscribe(event: string, listener: (value: Record<string, unknown>) => void) {
        const callbacks = listeners.get(event) ?? new Set();
        callbacks.add(listener);
        listeners.set(event, callbacks);
        return () => callbacks.delete(listener);
      },
      dispose: vi.fn(),
    };
    const emit = (event: string, value: Record<string, unknown>) => {
      for (const listener of listeners.get(event) ?? []) listener(value);
    };
    const session = await createWorkbenchSession({
      filesystem, persistence, runtime: runtime as unknown as RuntimeClient,
      iconPackStore: {
        read: async () => [], put: async () => {}, remove: async () => {},
        enable: async () => {}, subscribe: () => () => {}, dispose() {},
      },
    });
    const document = await session.documents.open("index.ts");
    session.kernel.configuration.register({
      id: "files.autoSave", title: "Auto Save", type: "string", default: "off",
    });
    const persist = vi.spyOn(session, "persist").mockRejectedValueOnce(new Error("Storage unavailable"));
    const kernelDispose = vi.spyOn(session.kernel, "dispose");
    const documentsDispose = vi.spyOn(session.documents, "dispose");
    const filesystemDispose = vi.spyOn(filesystem, "dispose");
    let disposed = false;
    try {
      await expect(session.dispose()).rejects.toThrow("Storage unavailable");
      expect(kernelDispose).not.toHaveBeenCalled();
      expect(documentsDispose).not.toHaveBeenCalled();
      expect(session.workbench.dispose).not.toHaveBeenCalled();
      expect(runtime.dispose).not.toHaveBeenCalled();
      expect(filesystemDispose).not.toHaveBeenCalled();

      emit("connection.change", { state: "disconnected" });
      expect(session.kernel.context.get("connected")).toBe(false);
      emit("workspace.trust", { trusted: true });
      expect(session.kernel.context.get("trusted")).toBe(true);
      vi.mocked(session.workbench.documentChanged).mockClear();
      document.replace("retained edit");
      expect(session.workbench.documentChanged).toHaveBeenCalled();
      const unload = new Event("beforeunload", { cancelable: true });
      browserWindow.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
      session.kernel.configuration.set("files.autoSave", "onWindowChange");
      browserWindow.dispatchEvent(new Event("blur"));
      await vi.waitFor(() => expect(document.dirty).toBe(false));
      expect((await filesystem.read("index.ts")).text).toBe("retained edit");

      await session.dispose();
      disposed = true;
      expect(persist).toHaveBeenCalledTimes(2);
      expect(kernelDispose).toHaveBeenCalledOnce();
      expect(documentsDispose).toHaveBeenCalledOnce();
      expect(session.workbench.dispose).toHaveBeenCalledOnce();
      expect(runtime.dispose).toHaveBeenCalledOnce();
      expect(filesystemDispose).toHaveBeenCalledOnce();
      expect([...listeners.values()].every((callbacks) => callbacks.size === 0)).toBe(true);
      const closed = new Event("beforeunload", { cancelable: true });
      browserWindow.dispatchEvent(closed);
      expect(closed.defaultPrevented).toBe(false);
    } finally {
      if (!disposed) {
        persist.mockRestore();
        await session.dispose();
      }
    }
  });
});
