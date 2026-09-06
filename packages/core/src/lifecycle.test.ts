import { afterEach, describe, expect, it, vi } from "vitest";
import type { Extension, Kernel } from "@zapp/sdk";
import { createKernel } from "./index";

const kernels: Kernel[] = [];
const kernel = () => {
  const value = createKernel();
  kernels.push(value);
  return value;
};
const extension = (
  id: string,
  activate: Extension["activate"],
  dependencies?: Record<string, string>,
): Extension => ({
  manifest: {
    manifestVersion: 1,
    id,
    name: id,
    version: "1.0.0",
    sdk: "^1.0.0",
    environments: ["browser"],
    activation: ["*"],
    capabilities: [],
    dependencies,
  },
  activate,
});
afterEach(() => {
  for (const value of kernels.splice(0)) value.dispose();
});

describe("extension lifecycle gaps", () => {
  it("hides pending contributions and removes an extension's surfaces together", async () => {
    const app = kernel();
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    app.extensions.register(
      extension("test.atomic", async (ctx) => {
        ctx.commands.register({ id: "test.run", title: "Run", run: () => 1 });
        ctx.contributions.register({
          id: "test.panel",
          title: "Panel",
          kind: "panel",
        });
        ctx.contributions.register({
          id: "test.status",
          title: "Status",
          kind: "statusItem",
        });
        started();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const activation = app.extensions.activate("test.atomic");
    await ready;
    expect(app.commands.list()).toEqual([]);
    expect(app.contributions.list()).toEqual([]);
    finish();
    await activation;
    expect(
      app.contributions.list().every((item) => item.owner === "test.atomic"),
    ).toBe(true);
    const sizes: number[] = [];
    app.contributions.subscribe(() =>
      sizes.push(app.contributions.list().length),
    );
    await app.extensions.disable("test.atomic");
    expect(sizes).not.toContain(1);
    expect(sizes.at(-1)).toBe(0);
  });
  it("aborts a pending activation and an extension-owned save hook on disable", async () => {
    const app = kernel();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    app.extensions.register(
      extension("test.pending", async () => {
        started();
        await new Promise<void>(() => {});
      }),
    );
    const activation = app.extensions.activate("test.pending");
    const rejected = expect(activation).rejects.toThrow("cancelled");
    await ready;
    await app.extensions.disable("test.pending");
    await rejected;
    let hookStarted!: () => void;
    const hookReady = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    app.extensions.register(
      extension("test.hook", (ctx) => {
        ctx.hooks.beforeSave("test.save", async () => {
          hookStarted();
          await new Promise<void>(() => {});
        });
      }),
    );
    await app.extensions.activate("test.hook");
    const save = app.hooks.runBeforeSave({
      documentId: "file",
      path: "index.ts",
      text: "content",
      signal: new AbortController().signal,
    });
    const cancelled = expect(save).rejects.toThrow("cancelled");
    await hookReady;
    await app.extensions.disable("test.hook");
    await cancelled;
  });
  it("rejects concurrent dependency cycles and starts unrelated features after failure", async () => {
    const app = kernel();
    app.extensions.register(
      extension("test.first", () => {}, { "test.second": "^1.0.0" }),
    );
    app.extensions.register(
      extension("test.second", () => {}, { "test.first": "^1.0.0" }),
    );
    const results = await Promise.allSettled([
      app.extensions.activate("test.first"),
      app.extensions.activate("test.second"),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    const activated = vi.fn();
    app.extensions.register(
      extension("test.failure", () => {
        throw new Error("Broken extension");
      }),
    );
    app.extensions.register(extension("test.healthy", activated));
    await app.extensions.trigger("onStartup");
    expect(activated).toHaveBeenCalledOnce();
  });
  it("keeps context-disabled menu entries and normalizes shortcut modifier order", () => {
    const app = kernel();
    app.contributions.register({
      id: "test.menu",
      title: "Unavailable",
      kind: "menu",
      when: "editor",
    });
    expect(app.contributions.list("menu")).toHaveLength(1);
    app.commands.register({
      id: "test.shortcut",
      title: "Shortcut",
      run: () => {},
    });
    app.contributions.register({
      id: "test.keys",
      kind: "shortcut",
      title: "Shortcut",
      command: "test.shortcut",
      priority: 10,
      data: "Shift+Ctrl+P",
    });
    expect(app.commands.resolveShortcut("Mod+Shift+P")?.id).toBe(
      "test.shortcut",
    );
  });
  it("keeps a setting changed before asynchronous stored settings arrive", async () => {
    let restore!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      restore = resolve;
    });
    const app = createKernel({
      persistence: {
        get: () => pending as Promise<any>,
        set: async () => {},
        delete: async () => {},
      },
    });
    kernels.push(app);
    app.configuration.register({
      id: "theme",
      title: "Theme",
      type: "string",
      default: "dark",
    });
    app.configuration.set("theme", "light");
    restore({ user: { theme: "dark" } });
    await pending;
    await Promise.resolve();
    expect(app.configuration.get("theme")).toBe("light");
  });
  it("keeps installed manifest settings through disable and restores schemas after a failed update", async () => {
    const app = kernel();
    const original = extension("test.settings", () => {});
    original.manifest.configuration = [
      {
        id: "test.setting",
        title: "Setting",
        type: "number",
        default: 2,
        max: 8,
      },
    ];
    app.extensions.register(original);
    expect(app.configuration.list().map((setting) => setting.id)).toContain(
      "test.setting",
    );
    app.configuration.set("test.setting", 6, "workspace");
    await app.extensions.activate(original.manifest.id);
    await app.extensions.disable(original.manifest.id);
    expect(app.configuration.get("test.setting")).toBe(6);
    expect(app.configuration.list().map((setting) => setting.id)).toContain(
      "test.setting",
    );
    await app.extensions.activate(original.manifest.id);
    const broken = extension("test.settings", () => {
      throw new Error("Broken settings release");
    });
    broken.manifest.version = "1.1.0";
    broken.manifest.configuration = [
      {
        id: "test.setting",
        title: "New setting",
        type: "number",
        default: 1,
        max: 3,
      },
    ];
    await expect(app.extensions.update(broken)).rejects.toThrow(
      "Broken settings release",
    );
    expect(app.configuration.get("test.setting")).toBe(6);
    expect(app.configuration.list()[0]?.title).toBe("Setting");
    await app.extensions.remove(original.manifest.id);
    expect(app.configuration.list()).toEqual([]);
    app.extensions.register(original);
    expect(app.configuration.get("test.setting")).toBe(6);
  });
  it("rolls back all manifest settings when installation has a duplicate schema", () => {
    const app = kernel();
    app.configuration.register({
      id: "existing",
      title: "Existing",
      type: "string",
      default: "value",
    });
    const duplicate = extension("test.duplicate", () => {});
    duplicate.manifest.configuration = [
      { id: "temporary", title: "Temporary", type: "boolean", default: false },
      { id: "existing", title: "Duplicate", type: "string", default: "" },
    ];
    expect(() => app.extensions.register(duplicate)).toThrow(
      "Duplicate setting",
    );
    expect(app.configuration.list().map((setting) => setting.id)).toEqual([
      "existing",
    ]);
    expect(app.extensions.list()).toEqual([]);
  });

  it("activates declared language and workspace triggers from host events", async () => {
    const app = kernel(),
      language = vi.fn(),
      workspace = vi.fn();
    const languageExtension = extension("test.language", language);
    languageExtension.manifest.activation = ["onLanguage:typescript"];
    const workspaceExtension = extension("test.workspace", workspace);
    workspaceExtension.manifest.activation = ["onWorkspace"];
    app.extensions.register(languageExtension);
    app.extensions.register(workspaceExtension);
    await app.extensions.trigger("onStartup");
    expect(language).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
    app.events.emit("document.open", { id: "document", path: "main.ts" });
    app.events.emit("workspace.change", { id: "browser", state: "closed" });
    await vi.waitFor(() => expect(language).toHaveBeenCalledOnce());
    expect(workspace).not.toHaveBeenCalled();
    app.events.emit("workspace.change", { id: "browser", state: "opened" });
    await vi.waitFor(() => expect(workspace).toHaveBeenCalledOnce());
  });

  it("lists lazy manifest commands, activates through shortcuts and reserves their IDs", async () => {
    const app = kernel(),
      activate = vi.fn((ctx: Parameters<Extension["activate"]>[0]) => {
        ctx.commands.register({
          id: "lazy.run",
          title: "Lazy Run",
          shortcut: "Mod+L",
          run: () => 42,
        });
      });
    const lazy = extension("test.lazy", activate);
    lazy.manifest.activation = ["onCommand:lazy.run"];
    lazy.manifest.commands = [
      { id: "lazy.run", title: "Lazy Run", shortcut: "Mod+L" },
    ];
    app.extensions.register(lazy);
    await app.extensions.trigger("onStartup");
    expect(activate).not.toHaveBeenCalled();
    expect(app.commands.list().map((command) => command.id)).toEqual([
      "lazy.run",
    ]);
    expect(() =>
      app.commands.register({
        id: "lazy.run",
        title: "Duplicate",
        run: () => {},
      }),
    ).toThrow("Duplicate command");
    expect(await app.commands.resolveShortcut("Ctrl+L")?.run()).toBe(42);
    expect(activate).toHaveBeenCalledOnce();
    await app.extensions.disable(lazy.manifest.id);
    expect(app.commands.list()).toEqual([]);
    await app.extensions.remove(lazy.manifest.id);
    expect(() =>
      app.commands.register({
        id: "lazy.run",
        title: "Replacement",
        run: () => {},
      }),
    ).not.toThrow();
  });
  it("keeps an updated dormant extension registered until its declared trigger", async () => {
    const app = kernel(),
      activate = vi.fn();
    const original = extension("test.dormant", activate);
    original.manifest.activation = ["onLanguage:typescript"];
    app.extensions.register(original);
    await app.extensions.update({
      ...original,
      manifest: { ...original.manifest, version: "1.1.0" },
    });
    expect(app.extensions.list()[0]?.state).toBe("registered");
    expect(activate).not.toHaveBeenCalled();
    await app.extensions.trigger("onLanguage:typescript");
    expect(activate).toHaveBeenCalledOnce();
  });
});
