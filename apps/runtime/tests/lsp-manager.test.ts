import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkspaceFiles } from "../src/filesystem.js";
import { LanguageServerManager, yamlSchemaSettings } from "../src/lsp-manager.js";
import { resolveLaunch, serverCatalog } from "../src/managed/catalog.js";
import { fingerprint, lockedPackages, ManagedInstaller, managedPlatforms, verifyIntegrity } from "../src/managed/install.js";
import nativeLock from "../src/managed/artifacts.lock.json" with { type: "json" };
import { createHash } from "node:crypto";
import { c as createTar } from "tar";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(idle = 300_000) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-lsp-manager-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.writeFile(path.join(root, "nested/package.json"), "{}");
  await fs.writeFile(path.join(root, "main.ts"), "export const x = 1;");
  await fs.writeFile(path.join(root, "nested/main.ts"), "export const x = 2;");
  const manager = new LanguageServerManager(new WorkspaceFiles(root), path.join(root, "cache"), () => {}, idle);
  cleanup.push(() => manager.dispose());
  return { root, manager };
}
describe("project language instances", () => {
  it("activates Laravel only inside an artisan root and recognizes Blade separately from PHP", async () => {
    const { manager, root } = await setup();
    await fs.writeFile(path.join(root, "plain.php"), "<?php");
    await expect(manager.attach("plain.php", "one", {}, {}, "laravel")).rejects.toThrow("artisan");
    expect(await manager.laravelRoot("plain.php")).toBeNull();
    await fs.writeFile(path.join(root, "nested/artisan"), "<?php");
    await fs.writeFile(path.join(root, "nested/composer.json"), "{}");
    await fs.mkdir(path.join(root, "nested/views"));
    await fs.writeFile(path.join(root, "nested/views/welcome.blade.php"), "<h1>Hello</h1>");
    const blade = await manager.attach("nested/views/welcome.blade.php", "one", {}, {}, "laravel");
    expect(blade.projectRootUri).toMatch(/\/nested$/);
    expect(lockedPackages(["@mdx-js/language-server", "typescript"]).has("node_modules/@mdx-js/language-server")).toBe(true);
  });
  it("shares identical instances and isolates roots and effective configuration", async () => {
    const { manager, root } = await setup();
    const a = await manager.attach("main.ts", "one"), b = await manager.attach("main.ts", "two");
    expect(a.instanceId).toBe(b.instanceId);
    const nested = await manager.attach("nested/main.ts", "one");
    expect(nested.instanceId).not.toBe(a.instanceId);
    expect(nested.projectRootUri).toContain("nested");
    const configured = await manager.attach("main.ts", "one", { typescript: { settings: { typescript: { preferences: { quotePreference: "single" } } } } });
    expect(configured.instanceId).not.toBe(a.instanceId);
    expect(await manager.projectRoot("nested/main.ts", ["nonexistent"])).toBe(root);
    expect(manager.list().every(item => item.state === "stopped")).toBe(true);
  });
  it("does not let associations or markers authorize paths outside the workspace", async () => {
    const { root, manager } = await setup();
    await expect(manager.attach("../outside.ts", "one")).rejects.toThrow();
    await expect(manager.attach("main.ts", "one", { typescript: { rootMarkers: ["../package.json"] } })).rejects.toThrow();
    await fs.symlink(os.tmpdir(), path.join(root, "escape"));
    await expect(manager.projectRoot("escape/file.ts", ["package.json"])).rejects.toThrow();
    await expect(manager.attach("main.ts", "one", { typescript: { enabled: false } })).rejects.toThrow("No enabled");
  });
  it("retains manual Stop across detach and reconnect", async () => {
    const { manager } = await setup();
    const a = await manager.attach("main.ts", "one");
    await manager.stop(true, a.instanceId);
    manager.detach("one");
    const b = await manager.attach("main.ts", "reconnected");
    expect(b.instanceId).toBe(a.instanceId);
    expect(b.paused).toBe(true);
    await expect(manager.start(false, b.instanceId)).rejects.toMatchObject({ code: "LSP_STOPPED" });
  });
  it("fans out each canonical edit once per instance without duplicate client streams", async () => {
    const { manager } = await setup();
    manager.canonical("main.ts", "one");
    const a = await manager.attach("main.ts", "one"), b = await manager.attach("main.ts", "two");
    manager.canonical("main.ts", "two");
    const versions = manager.versions(a.instanceId);
    expect(Object.values(versions)).toEqual([2]);
    expect(manager.versions(b.instanceId)).toEqual(versions);
    manager.detach("one");
    expect(Object.values(manager.versions(a.instanceId))).toEqual([2]);
    manager.detach("two");
    expect(manager.versions(a.instanceId)).toEqual({});
  });
});
describe("managed installation locks", () => {
  it("resolves exact transitive dependency trees without unrelated servers", () => {
    const vue = lockedPackages(["@vue/language-server", "@vue/typescript-plugin", "typescript-language-server", "typescript"]);
    expect(vue.has("node_modules/@vue/typescript-plugin")).toBe(true);
    expect(vue.has("node_modules/intelephense")).toBe(false);
    for (const entry of vue.values()) { expect(entry.integrity).toMatch(/^sha512-/); expect(entry.resolved).toMatch(/^https:\/\/registry.npmjs.org\//); }
    expect(fingerprint({ a: 1, b: { c: 2 } })).toBe(fingerprint({ b: { c: 2 }, a: 1 }));
  });
  it("locks the YAML and basedpyright trees", () => {
    for (const name of ["yaml-language-server", "basedpyright", "vscode-languageserver-protocol"]) {
      const tree = lockedPackages([name]);
      expect(tree.get(`node_modules/${name}`)?.version).toBe({ "yaml-language-server": "1.24.0", basedpyright: "1.40.2" }[name] ?? "3.18.3");
      for (const entry of tree.values()) { expect(entry.integrity).toMatch(/^sha512-/); expect(entry.resolved).toMatch(/^https:\/\/registry.npmjs.org\//); }
    }
  });
  it("rejects corruption, unsupported platforms and cancelled downloads", async () => {
    const bytes = Buffer.from("verified");
    const integrity = "sha256-" + createHash("sha256").update(bytes).digest("base64");
    expect(() => verifyIntegrity(bytes, integrity)).not.toThrow();
    expect(() => verifyIntegrity(Buffer.from("corrupt"), integrity)).toThrow("integrity");
    const { root } = await setup();
    const installer = new ManagedInstaller(path.join(root, "installer"));
    const controller = new AbortController(); controller.abort();
    await expect(installer.native("marksman", controller.signal)).rejects.toThrow();
    await expect(new ManagedInstaller(root, "win32-x64" as any).native("marksman")).rejects.toThrow("No pinned");
  });

  it("pins every native server for every managed platform", () => {
    const ids = [...new Set(nativeLock.artifacts.map(artifact => artifact.id))].sort();
    for (const platform of managedPlatforms)
      expect(nativeLock.artifacts.filter(artifact => artifact.platform === platform).map(artifact => artifact.id).sort(), platform).toEqual(ids);
  });

  it("extracts package archives and rejects links that leave the installation", async () => {
    const { root } = await setup();
    const installer = new ManagedInstaller(path.join(root, "installer")) as any;
    async function archive(name: string, build: (directory: string) => Promise<void>) {
      const source = path.join(root, `${name}-source`), file = path.join(root, `${name}.tgz`);
      await fs.mkdir(path.join(source, "package"), { recursive: true });
      await build(path.join(source, "package"));
      // tar 7.5.22's async pack can write a hardlink entry after it ends ("write after end"), uncaught.
      createTar({ gzip: true, cwd: source, file, portable: true, sync: true }, ["package"]);
      return fs.readFile(file);
    }
    const valid = await archive("valid", async directory => {
      await fs.writeFile(path.join(directory, "server.js"), "export {};");
      await fs.symlink("server.js", path.join(directory, "alias.js"));
    });
    await installer.extract(valid, path.join(root, "valid"), 1);
    expect(await fs.readFile(path.join(root, "valid/alias.js"), "utf8")).toBe("export {};");
    const symlink = await archive("symlink", directory => fs.symlink("../../outside", path.join(directory, "escape")));
    await expect(installer.extract(symlink, path.join(root, "symlink"), 1)).rejects.toThrow("Archive link leaves installation");
    const hardlink = await archive("hardlink", async directory => {
      await fs.writeFile(path.join(directory, "server.js"), "export {};");
      await fs.link(path.join(directory, "server.js"), path.join(directory, "linked.js"));
    });
    await expect(installer.extract(hardlink, path.join(root, "hardlink"), 1)).rejects.toThrow("Unsupported archive entry");
    await expect(fs.lstat(path.join(root, "symlink/escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("installs atomically once across concurrent callers and retains a working digest on failure", async () => {
  const { root } = await setup();
  const cache = path.join(root, "atomic-cache"), installer = new ManagedInstaller(cache, "linux-x64") as any;
  let builds = 0, release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const build = async (stage: string) => { builds++; await fs.writeFile(path.join(stage, "server"), "working"); await gate; };
  const first = installer.install("fixture", "first", build), second = installer.install("fixture", "first", build);
  await expect.poll(() => builds).toBe(1);
  await expect(fs.access(path.join(cache, "fixture-linux-x64", "first"))).rejects.toThrow();
  release(); const [a, b] = await Promise.all([first, second]); expect(a).toBe(b); expect(builds).toBe(1);
  await expect(installer.install("fixture", "next", async (stage: string) => { await fs.writeFile(path.join(stage, "server"), "partial"); throw new Error("Interrupted download"); })).rejects.toThrow("Interrupted download");
  expect(await fs.readFile(path.join(a, "server"), "utf8")).toBe("working");
  expect((await fs.readdir(path.dirname(a))).some(name => name.startsWith(".staging-") || name === ".install-lock")).toBe(false);
  const controller = new AbortController(); controller.abort();
  await expect(installer.install("fixture", "next", build, controller.signal)).rejects.toThrow();
  expect(await installer.install("fixture", "next", async (stage: string) => fs.writeFile(path.join(stage, "server"), "recovered"))).not.toBe(a);
});

it("repairs an interrupted installed tree after staging a complete replacement", async () => {
  const { root } = await setup();
  const installer = new ManagedInstaller(path.join(root, "repair-cache"), "linux-x64") as any;
  const target = await installer.install("fixture", "digest", async (stage: string) => fs.writeFile(path.join(stage, "server"), "first"));
  await fs.writeFile(path.join(target, ".complete"), "interrupted");
  await expect(installer.install("fixture", "digest", async () => { throw new Error("Offline"); })).rejects.toThrow("Offline");
  expect(await fs.readFile(path.join(target, "server"), "utf8")).toBe("first");
  expect(await installer.install("fixture", "digest", async (stage: string) => fs.writeFile(path.join(stage, "server"), "repaired"))).toBe(target);
  expect(await fs.readFile(path.join(target, "server"), "utf8")).toBe("repaired");
});

describe("YAML and Python presets", () => {
  async function fakeInstaller() {
    const { root } = await setup();
    const directory = path.join(root, "npm-install"), modules = path.join(directory, "node_modules"), installs: string[][] = [];
    await fs.mkdir(path.join(modules, "basedpyright/dist/typeshed-fallback"), { recursive: true });
    const installer = {
      cache: path.join(root, "cache"),
      npm: async (id: string, roots: string[]) => (installs.push(roots), { directory, version: `${roots[0]}@locked`, integrity: id }),
      native: async (id: string) => ({ directory, executable: path.join(directory, id), version: `${id}@pinned`, integrity: id }),
    } as unknown as ManagedInstaller;
    return { root, installer, modules, installs };
  }
  it("registers the presets for their languages", () => {
    const languages = Object.fromEntries(serverCatalog.map(preset => [preset.id, preset.selectors.map(selector => selector.language)]));
    expect(languages).toMatchObject({ yaml: ["yaml"], basedpyright: ["python"], ruff: ["python"] });
  });
  it("launches yaml-language-server over stdio with schema store settings", async () => {
    const { root, installer, modules, installs } = await fakeInstaller();
    const spec = await resolveLaunch("yaml", root, installer);
    expect(installs).toEqual([["yaml-language-server", "vscode-languageserver-protocol"]]);
    expect(spec.executable).toBe(process.execPath);
    expect(spec.args.slice(-2)).toEqual([path.join(modules, "yaml-language-server/bin/yaml-language-server"), "--stdio"]);
    expect(spec.version).toBe("yaml-language-server@locked");
    expect(spec.settings).toEqual({ yaml: { validate: true, hover: true, completion: true, format: { enable: true }, schemaStore: { enable: true, url: "https://www.schemastore.org/api/json/catalog.json" }, keyOrdering: false } });
  });
  it("disables the YAML schema store with the JSON schema gates", () => {
    const settings = { yaml: { schemaStore: { enable: true, url: "https://example.test/catalog.json" }, hover: true } };
    expect(yamlSchemaSettings(settings, { catalog: true, download: true }).yaml.schemaStore).toEqual(settings.yaml.schemaStore);
    expect(yamlSchemaSettings(settings, { catalog: false, download: true }).yaml.schemaStore.enable).toBe(false);
    expect(yamlSchemaSettings(settings, { catalog: true, download: false }).yaml).toEqual({ hover: true, schemaStore: { enable: false, url: "https://example.test/catalog.json" } });
    expect(yamlSchemaSettings({ yaml: { schemaStore: { enable: false } } }, { catalog: true, download: true }).yaml.schemaStore.enable).toBe(false);
  });
  it("launches basedpyright over stdio with standard open-file checking", async () => {
    const { root, installer, modules, installs } = await fakeInstaller();
    const spec = await resolveLaunch("basedpyright", root, installer);
    expect(installs).toEqual([["basedpyright"]]);
    expect(spec.args.slice(-2)).toEqual([path.join(modules, "basedpyright/langserver.index.js"), "--stdio"]);
    expect(spec.version).toBe("basedpyright@locked");
    expect(spec.settings).toEqual({ basedpyright: { analysis: { typeCheckingMode: "standard", diagnosticMode: "openFilesOnly" } } });
    expect(spec.dependencyRoots).toEqual([await fs.realpath(path.join(modules, "basedpyright/dist/typeshed-fallback"))]);
  });
  it("launches the pinned Ruff binary as a language server", async () => {
    const { root, installer } = await fakeInstaller();
    const spec = await resolveLaunch("ruff", root, installer);
    expect(spec).toEqual({ executable: path.join(root, "npm-install", "ruff"), args: ["server"], version: "ruff@pinned" });
  });
});
