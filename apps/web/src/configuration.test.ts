import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient, Kernel } from "@zapp/sdk";
import {
  BrowserFileSystem,
  MemoryPersistence,
} from "../../../packages/host-browser/src/index";
import { ScopedConfigurationPersistence } from "./configuration";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
const setup = async () => {
  const storage = new MemoryPersistence();
  const filesystem = new BrowserFileSystem(storage, "settings-test");
  await filesystem.mkdir(".zapp");
  await filesystem.write(".zapp/settings.json", '{"editor.fontSize":13}\n', {
    expectedRevision: null,
  });
  const runtime = {
    connected: true,
    async request(method: string, args: any) {
      if (!this.connected) throw new Error("Offline");
      if (method === "fs.read") return filesystem.read(args.path);
      if (method === "fs.mkdir") return filesystem.mkdir(args.path);
      if (method === "fs.write")
        return filesystem.write(args.path, args.text, args);
      throw new Error(method);
    },
    subscribe: () => () => {},
  } as unknown as RpcClient;
  const create = () => {
    const settings = new ScopedConfigurationPersistence(
      storage,
      filesystem,
      runtime,
    );
    cleanup.push(() => settings.dispose());
    return settings;
  };
  return { storage, filesystem, runtime, create };
};
it("recovers pending workspace settings after refresh and writes their saved revision", async () => {
  const { storage, filesystem, runtime, create } = await setup();
  const first = create();
  const layers = (await first.get<any>("settings"))!;
  runtime.connected = false;
  layers.workspace["editor.fontSize"] = 18;
  await first.set("settings", layers);
  first.dispose();
  runtime.connected = true;
  const second = create();
  expect(
    (await second.get<any>("settings"))?.workspace["editor.fontSize"],
  ).toBe(18);
  await vi.waitFor(async () =>
    expect(
      JSON.parse((await filesystem.read(".zapp/settings.json")).text)[
        "editor.fontSize"
      ],
    ).toBe(18),
  );
  expect(await storage.get(second.key + ":pending")).toBeUndefined();
});
it("keeps recovered settings when their disk revision changed while offline", async () => {
  const { storage, filesystem, runtime, create } = await setup();
  const first = create();
  const layers = (await first.get<any>("settings"))!;
  runtime.connected = false;
  layers.workspace["editor.fontSize"] = 18;
  await first.set("settings", layers);
  first.dispose();
  const disk = await filesystem.read(".zapp/settings.json");
  await filesystem.write(disk.path, '{"editor.fontSize":22}', {
    expectedRevision: disk.revision,
  });
  runtime.connected = true;
  const second = create();
  expect(
    (await second.get<any>("settings"))?.workspace["editor.fontSize"],
  ).toBe(18);
  expect(
    JSON.parse((await filesystem.read(disk.path)).text)["editor.fontSize"],
  ).toBe(22);
  expect(await storage.get(second.key + ":pending")).toBeDefined();
});
it("clears stale offline writes when a setting is reset to saved content", async () => {
  const { storage, runtime, create } = await setup();
  const settings = create();
  const layers = (await settings.get<any>("settings"))!;
  runtime.connected = false;
  layers.workspace["editor.fontSize"] = 18;
  await settings.set("settings", layers);
  layers.workspace["editor.fontSize"] = 13;
  await settings.set("settings", layers);
  expect(await storage.get(settings.key + ":pending")).toBeUndefined();
});
it("removes workspace overrides when the disk settings file is deleted", async () => {
  const { filesystem, create } = await setup();
  const settings = create();
  const layers = (await settings.get<any>("settings"))!;
  const imported = vi.fn();
  settings.attach(
    {
      configuration: { export: () => layers, import: imported },
    } as unknown as Kernel,
    vi.fn(),
  );
  await filesystem.delete(".zapp/settings.json");
  await vi.waitFor(() =>
    expect(imported).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: {}, workspaceLanguages: {} }),
    ),
  );
});
it("resolves recovered setting conflicts through an explicit local save", async () => {
  const { filesystem, runtime, create } = await setup();
  const settings = create();
  const layers = (await settings.get<any>("settings"))!;
  settings.attach(
    {
      configuration: { export: () => layers, import: vi.fn() },
    } as unknown as Kernel,
    vi.fn(),
  );
  runtime.connected = false;
  layers.workspace["editor.fontSize"] = 18;
  await settings.set("settings", layers);
  const disk = await filesystem.read(".zapp/settings.json");
  await filesystem.write(disk.path, '{"editor.fontSize":22}', {
    expectedRevision: disk.revision,
  });
  runtime.connected = true;
  await settings.resolveWorkspaceSettings("local");
  expect(
    JSON.parse((await filesystem.read(disk.path)).text)["editor.fontSize"],
  ).toBe(18);
});
