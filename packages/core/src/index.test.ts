import { afterEach, describe, expect, it, vi } from "vitest";
import type { Extension, ExtensionContext, Kernel } from "@zapp/sdk";
import { createKernel } from "./index";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const kernels: Kernel[] = [];
const makeKernel = () => {
  const kernel = createKernel();
  kernels.push(kernel);
  return kernel;
};
const extension = (
  id: string,
  activate: Extension["activate"],
  options: Partial<Extension["manifest"]> = {},
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
    ...options,
  },
  activate,
});
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
  vi.useRealTimers();
});

describe("kernel contracts", () => {
  it("validates setting values and applies all five configuration layers", () => {
    const kernel = makeKernel();
    kernel.configuration.register({
      id: "editor.tabSize",
      title: "Tab Size",
      type: "number",
      default: 2,
      min: 1,
      max: 8,
    });
    kernel.configuration.set("editor.tabSize", 3, "user");
    kernel.configuration.set("editor.tabSize", 4, "workspace");
    kernel.configuration.set("editor.tabSize", 5, "user", "typescript");
    kernel.configuration.set("editor.tabSize", 6, "workspace", "typescript");
    expect(kernel.configuration.get("editor.tabSize", "typescript")).toBe(6);
    expect(kernel.configuration.get("editor.tabSize", "json")).toBe(4);
    kernel.configuration.reset("editor.tabSize", "workspace", "typescript");
    expect(kernel.configuration.get("editor.tabSize", "typescript")).toBe(5);
    expect(() => kernel.configuration.set("editor.tabSize", 9)).toThrow(
      "range",
    );
    expect(() => kernel.configuration.set("editor.tabSize", "4")).toThrow(
      "number",
    );
  });
  it("rejects duplicate IDs and uses context and priority for shortcut conflicts", async () => {
    const kernel = makeKernel();
    const run = vi.fn();
    kernel.commands.register({
      id: "global.save",
      title: "Save",
      shortcut: "Mod+S",
      run,
    });
    kernel.commands.register({
      id: "editor.save",
      title: "Save Editor",
      shortcut: "Ctrl+S",
      when: "editorFocus && !readonly",
      priority: 5,
      run,
    });
    expect(() =>
      kernel.commands.register({ id: "global.save", title: "Duplicate", run }),
    ).toThrow("Duplicate");
    expect(kernel.commands.resolveShortcut("Meta+S")?.id).toBe("global.save");
    kernel.context.set("editorFocus", true);
    expect(kernel.commands.resolveShortcut("Mod+S")?.id).toBe("editor.save");
    kernel.context.set("readonly", true);
    await expect(kernel.commands.execute("editor.save")).rejects.toThrow(
      "Requires",
    );
    kernel.context.set("language", "typescript");
    expect(
      kernel.context.matches(
        "language == typescript && (readonly || editorFocus)",
      ),
    ).toBe(true);
    expect(kernel.context.matches("language == json")).toBe(false);
  });
  it("runs save hooks sequentially and blocks recursive saves", async () => {
    const kernel = makeKernel();
    const signal = new AbortController().signal;
    kernel.hooks.beforeSave("second", async ({ text }) => `${text}B`, 2);
    kernel.hooks.beforeSave("first", async ({ text }) => `${text}A`, 1);
    expect(
      await kernel.hooks.runBeforeSave({
        documentId: "one",
        path: "one.ts",
        text: "",
        signal,
      }),
    ).toBe("AB");
    kernel.hooks.beforeSave(
      "recursive",
      async (ctx) => {
        await kernel.hooks.runBeforeSave(ctx);
      },
      3,
    );
    await expect(
      kernel.hooks.runBeforeSave({
        documentId: "one",
        path: "one.ts",
        text: "",
        signal,
      }),
    ).rejects.toThrow("Recursive");
  });
  it("aborts timed out save hooks and accepts a later save", async () => {
    vi.useFakeTimers();
    const kernel = makeKernel();
    let hookSignal: AbortSignal | undefined;
    const registration = kernel.hooks.beforeSave("blocked", (ctx) => {
      hookSignal = ctx.signal;
      return new Promise(() => {});
    });
    const pending = kernel.hooks.runBeforeSave(
      {
        documentId: "one",
        path: "one.ts",
        text: "x",
        signal: new AbortController().signal,
      },
      20,
    );
    const rejected = expect(pending).rejects.toThrow("exceeded");
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(hookSignal?.aborted).toBe(true);
    registration.dispose();
    expect(
      await kernel.hooks.runBeforeSave({
        documentId: "one",
        path: "one.ts",
        text: "x",
        signal: new AbortController().signal,
      }),
    ).toBe("x");
  });
  it("lazily activates commands and disposes contributions, subscriptions and owned work", async () => {
    const kernel = makeKernel();
    const cleanup = vi.fn();
    let context: ExtensionContext | undefined;
    kernel.extensions.register(
      extension(
        "test.lazy",
        (ctx) => {
          context = ctx;
          ctx.commands.register({
            id: "test.run",
            title: "Run",
            run: () => 42,
          });
          ctx.contributions.register({
            id: "test.panel",
            kind: "panel",
            title: "Panel",
          });
          ctx.events.on("document.close", cleanup);
          ctx.subscribe(cleanup);
        },
        { activation: ["onCommand:test.run"] },
      ),
    );
    expect(kernel.commands.list()).toHaveLength(0);
    expect(await kernel.commands.execute("test.run")).toBe(42);
    await kernel.extensions.disable("test.lazy");
    expect(context?.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(kernel.commands.list()).toHaveLength(0);
    expect(kernel.contributions.list()).toHaveLength(0);
    kernel.events.emit("document.close", { id: "file" });
    expect(cleanup).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 10; index++) {
      await kernel.extensions.activate("test.lazy");
      await kernel.extensions.disable("test.lazy");
    }
    expect(kernel.commands.list()).toHaveLength(0);
    expect(cleanup).toHaveBeenCalledTimes(11);
  });
  it("rolls back failed activation and retries after the cause is fixed", async () => {
    const kernel = makeKernel();
    let fail = true;
    kernel.extensions.register(
      extension("test.failure", (ctx) => {
        ctx.commands.register({
          id: "failure.run",
          title: "Run",
          run: () => 1,
        });
        if (fail) throw new Error("Activation failed");
      }),
    );
    await expect(kernel.extensions.activate("test.failure")).rejects.toThrow(
      "Activation failed",
    );
    expect(kernel.commands.list()).toHaveLength(0);
    expect(kernel.extensions.list()[0]?.state).toBe("failed");
    fail = false;
    await kernel.extensions.activate("test.failure");
    expect(kernel.commands.list()).toHaveLength(1);
  });
  it("rejects dependency cycles and incompatible updates", async () => {
    const kernel = makeKernel();
    kernel.extensions.register(
      extension("cycle.first", () => {}, {
        dependencies: { "cycle.second": "^1.0.0" },
      }),
    );
    kernel.extensions.register(
      extension("cycle.second", () => {}, {
        dependencies: { "cycle.first": "^1.0.0" },
      }),
    );
    await expect(kernel.extensions.activate("cycle.first")).rejects.toThrow(
      "cycle",
    );
    await expect(
      kernel.extensions.update(
        extension("cycle.first", () => {}, { version: "2.0.0" }),
      ),
    ).rejects.toThrow("breaks");
    expect(() =>
      kernel.extensions.register(
        extension("bad.sdk", () => {}, { sdk: "^2.0.0" }),
      ),
    ).toThrow("incompatible");
  });
  it("restores the earlier active extension after a failed update", async () => {
    const kernel = makeKernel();
    kernel.extensions.register(
      extension("test.update", (ctx) => {
        ctx.commands.register({
          id: "version",
          title: "Version",
          run: () => "1.0.0",
        });
      }),
    );
    await kernel.extensions.activate("test.update");
    await expect(
      kernel.extensions.update(
        extension(
          "test.update",
          () => {
            throw new Error("Broken release");
          },
          { version: "1.1.0" },
        ),
      ),
    ).rejects.toThrow("Broken release");
    expect(await kernel.commands.execute("version")).toBe("1.0.0");
    expect(kernel.extensions.list()[0]?.state).toBe("active");
  });
  it("loads an external ESM artifact through the public extension contract", async () => {
    const kernel = makeKernel();
    const directory = await mkdtemp(join(tmpdir(), "zapp-extension-"));
    const path = join(directory, "extension.mjs");
    try {
      await writeFile(
        path,
        `export default {manifest:{manifestVersion:1,id:'external.example',name:'External',version:'1.0.0',sdk:'^1.0.0',environments:['browser'],activation:['onCommand:external.command'],commands:[{id:'external.command',title:'External Command'}],capabilities:[]},activate(ctx){ctx.commands.register({id:'external.command',title:'External Command',run:()=>42});ctx.contributions.register({id:'external.panel',kind:'panel',title:'External Panel'});}};`,
      );
      expect(await kernel.extensions.load(pathToFileURL(path).href)).toBe(
        "external.example",
      );
      expect(await kernel.commands.execute("external.command")).toBe(42);
      await kernel.extensions.remove("external.example");
      expect(kernel.commands.list()).toHaveLength(0);
      expect(kernel.contributions.list()).toHaveLength(0);
      const deferred = makeKernel();
      await deferred.extensions.load(pathToFileURL(path).href, {
        activate: false,
      });
      expect(deferred.extensions.list()[0]?.state).toBe("registered");
      expect(deferred.contributions.list()).toHaveLength(0);
      expect(deferred.commands.list().map((command) => command.id)).toEqual([
        "external.command",
      ]);
      expect(await deferred.commands.execute("external.command")).toBe(42);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rolls back a deliberately failing external ESM activation", async () => {
    const kernel = makeKernel();
    const directory = await mkdtemp(join(tmpdir(), "zapp-extension-failure-"));
    const path = join(directory, "failure.mjs");
    try {
      await writeFile(
        path,
        `export default {manifest:{manifestVersion:1,id:'external.failure',name:'Failure',version:'1.0.0',sdk:'^1.0.0',environments:['browser'],activation:[],capabilities:[]},activate(ctx){ctx.commands.register({id:'external.temporary',title:'Temporary',run:()=>null});throw new Error('Deliberate external failure');}};`,
      );
      await expect(
        kernel.extensions.load(pathToFileURL(path).href),
      ).rejects.toThrow("Deliberate external failure");
      expect(kernel.commands.list()).toHaveLength(0);
      expect(kernel.extensions.list()[0]?.state).toBe("failed");
      await kernel.extensions.remove("external.failure");
      expect(kernel.extensions.list()).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
