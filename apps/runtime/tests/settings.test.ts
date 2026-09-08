import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { settingsChanges, settingsLayers, settingsSchema } from "@oxbit/sdk";
import { pathToFileURL, fileURLToPath } from "node:url";
import { SettingsStore } from "../src/settings.js";
import { WorkspaceFiles } from "../src/filesystem.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-settings-"));
  cleanup.push(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "workspace"); await fs.mkdir(root);
  let events = 0;
  const store = await new SettingsStore(new WorkspaceFiles(root), path.join(base, "user/settings.json"), path.join(base, "projects/id"), () => events++).initialize();
  cleanup.push(() => store.dispose());
  const write = async (index: number, value: unknown) => { await fs.mkdir(path.dirname(store.paths[index]), { recursive: true }); await fs.writeFile(store.paths[index], JSON.stringify(value)); };
  return { base, root, store, write, events: () => events };
}

describe("merged settings files", () => {
  it("creates private defaults, migrates old settings once and never creates root overrides", async () => {
    const { root, store } = await fixture();
    await fs.mkdir(path.join(root, ".oxbit"));
    await fs.writeFile(path.join(root, ".oxbit/settings.json"), '{"editor.tabSize": 3}');
    const first = await store.read(settingsLayers({ "editor.fontSize": 15 }, { "editor.wordWrap": true }));
    expect(first.layers).toMatchObject({ user: { "editor.fontSize": 15 }, workspace: { "editor.tabSize": 3, "editor.wordWrap": true } });
    expect(first.files.map(file => file.exists)).toEqual([true, true, false, false]);
    expect((await fs.stat(store.paths[0])).mode & 0o777).toBe(0o600);
    for (const file of store.paths.slice(0, 2)) {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      const schemaFile = fileURLToPath(new URL(value.$schema, pathToFileURL(file)));
      expect(schemaFile).toBe(store.schemaFile);
      expect(JSON.parse(await fs.readFile(schemaFile, "utf8"))).toEqual(settingsSchema);
    }
    expect(first.layers.user).not.toHaveProperty("$schema");
    await fs.writeFile(path.join(root, ".oxbit/settings.json"), '{"editor.tabSize": 8}');
    expect((await store.read(settingsLayers({ "editor.fontSize": 99 }, {}))).layers).toEqual(first.layers);
    await expect(fs.stat(path.join(root, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves a manually chosen schema URI and refreshes the installed schema on initialization", async () => {
    const { store, root, write } = await fixture();
    await write(0, { $schema: "https://example.com/my-schema.json", "editor.tabSize": 3 });
    await store.read();
    await store.patch([{ scope: "user", path: ["editor.tabSize"], before: 3, value: 4 }]);
    expect(JSON.parse(await fs.readFile(store.paths[0], "utf8")).$schema).toBe("https://example.com/my-schema.json");
    await fs.writeFile(store.schemaFile, "{}");
    const other = await new SettingsStore(new WorkspaceFiles(root), store.userFile, store.projectDirectory).initialize();
    cleanup.push(() => other.dispose());
    expect(JSON.parse(await fs.readFile(store.schemaFile, "utf8"))).toEqual(settingsSchema);
  });
  it("deep merges all four files and language blocks, with arrays and null replacing", async () => {
    const { store, write } = await fixture();
    await write(0, { servers: { ts: { enabled: true, args: ["user"], config: { a: 1 } } }, "[mdx]": { "editor.tabSize": 2 } });
    await write(1, { servers: { ts: { config: { b: 2 } } }, "[mdx]": { "editor.wordWrap": true } });
    await write(2, { servers: { ts: { args: ["project"], config: { b: 3 } } } });
    await write(3, { servers: { ts: { args: [], config: { c: null } } }, "[mdx]": { "editor.tabSize": 4 } });
    const { layers } = await store.read();
    expect(layers.workspace.servers).toEqual({ ts: { args: [], config: { b: 3, c: null } } });
    expect(layers.workspaceLanguages.mdx).toEqual({ "editor.wordWrap": true, "editor.tabSize": 4 });
    expect(layers.userLanguages.mdx).toEqual({ "editor.tabSize": 2 });
  });
  it("patches only changed leaves in the highest existing file, and reset reveals the lower layer", async () => {
    const { store, write } = await fixture(); await store.read();
    await write(1, { servers: { ts: { enabled: true, setting: 1 } }, keep: "private" });
    await write(2, { servers: { ts: { setting: 2 } }, keep: "shared", extra: true });
    await write(3, { servers: { ts: { setting: 3 } } });
    const before = (await store.read()).layers, next = structuredClone(before);
    (next.workspace.servers as any).ts.setting = 4;
    const result = await store.patch(settingsChanges(before, next));
    expect(JSON.parse(await fs.readFile(store.paths[3], "utf8"))).toEqual({ servers: { ts: { setting: 4 } } });
    expect(result.layers.workspace.keep).toBe("shared");
    const reset = structuredClone(result.layers); delete reset.workspace.servers;
    expect((await store.patch(settingsChanges(result.layers, reset))).layers.workspace.servers).toEqual({ ts: { enabled: true, setting: 2 } });
    expect(JSON.parse(await fs.readFile(store.paths[2], "utf8"))).toEqual({ servers: { ts: { setting: 2 } }, keep: "shared", extra: true });
  });
  it("serializes independent windows without losing keys and rejects same-key conflicts", async () => {
    const { store, root, write } = await fixture(); await write(0, { first: 1, second: 1 });
    await store.read();
    const other = await new SettingsStore(new WorkspaceFiles(root), store.userFile, store.projectDirectory).initialize(); cleanup.push(() => other.dispose());
    await Promise.all([store.patch([{ scope: "user", path: ["first"], before: 1, value: 2 }]), other.patch([{ scope: "user", path: ["second"], before: 1, value: 3 }])]);
    expect((await store.read()).layers.user).toEqual({ first: 2, second: 3 });
    await expect(other.patch([{ scope: "user", path: ["first"], before: 1, value: 5 }])).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.read()).layers.user.first).toBe(2);
  });
  it("notifies on edits, creation, atomic replacement and deletion; invalid JSON retains the last valid layer", async () => {
    const { store, write, events } = await fixture(); await store.read();
    let count = events(); await write(2, { value: 1 });
    await expect.poll(events).toBeGreaterThan(count);
    expect((await store.read()).layers.workspace.value).toBe(1);
    count = events(); const temp = store.paths[2] + ".tmp"; await fs.writeFile(temp, '{"value":2}'); await fs.rename(temp, store.paths[2]);
    await expect.poll(events).toBeGreaterThan(count);
    expect((await store.read()).layers.workspace.value).toBe(2);
    await fs.writeFile(store.paths[2], "{");
    const invalid = await store.read(); expect(invalid.layers.workspace.value).toBe(2); expect(invalid.files[2].error).toBeTruthy();
    await expect(store.patch([{ scope: "workspace", path: ["value"], before: 2, value: 4 }])).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await fs.readFile(store.paths[2], "utf8")).toBe("{");
    count = events(); await fs.rm(store.paths[2]); await expect.poll(events).toBeGreaterThan(count);
    expect((await store.read()).layers.workspace).toEqual({});
  });
  it("rejects unsafe JSON and settings paths redirected outside the project", async () => {
    const { store, root, base } = await fixture(); await store.read();
    await fs.mkdir(path.join(base, "outside/oxbit"), { recursive: true });
    await fs.writeFile(path.join(base, "outside/oxbit/settings.json"), '{"secret":true}');
    await fs.symlink(path.join(base, "outside"), path.join(root, ".config"));
    const result = await store.read(); expect(result.layers.workspace).toEqual({}); expect(result.files[2].error).toMatch(/Symlink/);
    await expect(store.patch([{ scope: "user", path: ["__proto__", "polluted"], value: true }])).rejects.toThrow();
    expect(({} as any).polluted).toBeUndefined();
  });
});
