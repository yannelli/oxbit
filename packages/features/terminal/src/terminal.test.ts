import { describe, expect, it, vi } from "vitest";
import type { FeatureOptions } from "@zapp/sdk";
import { createKernel } from "../../../core/src/index";
import { createFeature } from "./index";

vi.mock("./addons.js", () => ({ loadOptionalAddons: vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));

describe("terminal lifecycle events", () => {
  it("emits session state changes without an event for each output chunk", async () => {
    const kernel = createKernel(), subscribers = new Map<string, (params: any) => void>();
    const runtime = {
      connected: false,
      request: vi.fn(async (method: string): Promise<any> => {
        if (method === "terminal.create") return { id: "session" };
        if (method === "terminal.list") return [{ id: "session" }];
        if (method === "terminal.attach") return { chunks: [], seq: 2 };
        return {};
      }),
      subscribe: (event: string, listener: (params: any) => void) => { subscribers.set(event, listener); return () => { subscribers.delete(event); }; },
    };
    const options = { kernel, runtime, workbench: { openPanel: vi.fn() } } as unknown as FeatureOptions;
    const feature = createFeature(options), events: string[] = [];
    kernel.events.on("terminal.change", event => events.push(event.state));
    kernel.extensions.register(feature);
    try {
      await kernel.extensions.activate(feature.manifest.id);
      runtime.connected = true;
      const service = kernel.services.get<{ create(): Promise<unknown>; kill(id: string): Promise<void> }>("terminal");
      await service.create();
      subscribers.get("terminal.data")!({ id: "session", seq: 1, data: "first" });
      subscribers.get("terminal.data")!({ id: "session", seq: 2, data: "second" });
      expect(events).toEqual(["running"]);
      runtime.connected = false; subscribers.get("connection.change")!({ state: "disconnected" });
      runtime.connected = true; subscribers.get("connection.change")!({ state: "connected" });
      await vi.waitFor(() => expect(events).toEqual(["running", "disconnected", "running"]));
      subscribers.get("terminal.exit")!({ id: "session", exitCode: 7 });
      await service.kill("session");
      expect(events).toEqual(["running", "disconnected", "running", "terminated (7)", "closed"]);
    } finally { kernel.dispose(); }
  });
});
