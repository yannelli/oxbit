import { expect, it, vi } from "vitest";
import type { RpcClient } from "@oxbit/sdk";
import { settingsLayers } from "@oxbit/sdk";
import { BrowserFileSystem, MemoryPersistence } from "../../../packages/host-browser/src/index";
import { ScopedConfigurationPersistence } from "./configuration";

it("retains browser-only profiles and workspace language settings without creating repository files", async () => {
  const storage = new MemoryPersistence(), filesystem = new BrowserFileSystem(storage, "browser");
  const first = new ScopedConfigurationPersistence(storage, filesystem);
  await first.get("settings");
  const layers = settingsLayers({ "editor.fontSize": 18 }, { "[mdx]": { "editor.tabSize": 4 } });
  await first.set("settings", layers); await first.dispose();
  const second = new ScopedConfigurationPersistence(storage, filesystem);
  expect(await second.get("settings")).toEqual(layers);
  expect(await filesystem.list("")).toEqual([]);
  await second.dispose();
});
it("keeps guest preferences in client storage without reading the owner's private files", async () => {
  const storage = new MemoryPersistence(), filesystem = new BrowserFileSystem(storage, "guest");
  const request = vi.fn(), runtime = { connected: true, session: { owner: false }, request, subscribe: () => () => {} } as RpcClient;
  const settings = new ScopedConfigurationPersistence(storage, filesystem, runtime);
  await settings.get("settings"); await settings.set("settings", settingsLayers({ "editor.fontSize": 18 }, {}));
  expect(request).not.toHaveBeenCalled();
  expect(await storage.get("profile-settings")).toMatchObject({ user: { "editor.fontSize": 18 } });
  await settings.dispose();
});
it("retains edits made before the first runtime connection and does not expose mutable persistence snapshots", async () => {
  const storage = new MemoryPersistence(), filesystem = new BrowserFileSystem(storage, "offline");
  const runtime = { connected: false, request: async () => { throw new Error("Offline"); }, subscribe: () => () => {} } as RpcClient;
  const first = new ScopedConfigurationPersistence(storage, filesystem, runtime);
  const layers = (await first.get<any>("settings"))!;
  layers.workspace["editor.fontSize"] = 18;
  await first.set("settings", layers); await first.dispose();
  const second = new ScopedConfigurationPersistence(storage, filesystem, runtime);
  expect((await second.get<any>("settings"))?.workspace["editor.fontSize"]).toBe(18);
  expect((await storage.get<any>(second.key + ":files")).pending).toEqual([{ scope: "workspace", path: ["editor.fontSize"], value: 18 }]);
  await second.dispose();
});
it("clears pending offline changes when settings return to the last saved contents", async () => {
  const storage = new MemoryPersistence(), filesystem = new BrowserFileSystem(storage, "reset");
  const saved = settingsLayers({}, { "editor.fontSize": 13 });
  await storage.set("settings", saved);
  const runtime = { connected: false, request: async () => { throw new Error("Offline"); }, subscribe: () => () => {} } as RpcClient;
  const settings = new ScopedConfigurationPersistence(storage, filesystem, runtime);
  const layers = (await settings.get<any>("settings"))!;
  layers.workspace["editor.fontSize"] = 18; await settings.set("settings", layers);
  layers.workspace["editor.fontSize"] = 13; await settings.set("settings", layers);
  expect((await storage.get<any>(settings.key + ":files")).pending).toEqual([]);
  await settings.dispose();
});
