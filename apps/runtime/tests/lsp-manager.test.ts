import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkspaceFiles } from "../src/filesystem.js";
import { LanguageServerManager } from "../src/lsp-manager.js";
import { fingerprint, lockedPackages, ManagedInstaller, verifyIntegrity } from "../src/managed/install.js";
import { createHash } from "node:crypto";

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
});

it("installs atomically once across concurrent callers and retains a working digest on failure", async () => {
  const { root } = await setup();
  const cache = path.join(root, "atomic-cache"), installer = new ManagedInstaller(cache) as any;
  let builds = 0, release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const build = async (stage: string) => { builds++; await fs.writeFile(path.join(stage, "server"), "working"); await gate; };
  const first = installer.install("fixture", "first", build), second = installer.install("fixture", "first", build);
  await expect.poll(() => builds).toBe(1);
  await expect(fs.access(path.join(cache, `fixture-${process.platform}-${process.arch}`, "first"))).rejects.toThrow();
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
  const installer = new ManagedInstaller(path.join(root, "repair-cache")) as any;
  const target = await installer.install("fixture", "digest", async (stage: string) => fs.writeFile(path.join(stage, "server"), "first"));
  await fs.writeFile(path.join(target, ".complete"), "interrupted");
  await expect(installer.install("fixture", "digest", async () => { throw new Error("Offline"); })).rejects.toThrow("Offline");
  expect(await fs.readFile(path.join(target, "server"), "utf8")).toBe("first");
  expect(await installer.install("fixture", "digest", async (stage: string) => fs.writeFile(path.join(stage, "server"), "repaired"))).toBe(target);
  expect(await fs.readFile(path.join(target, "server"), "utf8")).toBe("repaired");
});
