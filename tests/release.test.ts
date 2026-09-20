import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
// @ts-expect-error plain-node release script without types
import { assertReleasable, commitRelease, desktopArtifacts, iosArtifacts, nextVersion, setVersion, updaterKeyMissing, versionFiles } from "../scripts/release.mjs";

describe("release version bumping", () => {
  it("steps each semver field and accepts an explicit version", () => {
    expect(nextVersion("0.1.1", "patch")).toBe("0.1.2");
    expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(nextVersion("0.9.3", "major")).toBe("1.0.0");
    expect(nextVersion("0.1.1", "2.4.0")).toBe("2.4.0");
    expect(() => nextVersion("0.1.1", "next")).toThrow("patch, minor, major");
    expect(() => nextVersion("0.1.1-beta", "patch")).toThrow("non-semver");
  });
  it("rewrites the package manifest version and leaves dependency versions alone", () => {
    const manifest = '{\n  "name": "oxbit",\n  "version": "0.1.1",\n  "dependencies": { "tar": "7.5.9" }\n}\n';
    const bumped = setVersion("package.json", manifest, "0.2.0");
    expect(JSON.parse(bumped)).toMatchObject({
      version: "0.2.0",
      dependencies: { tar: "7.5.9" },
    });
    expect(bumped).toBe(manifest.replace("0.1.1", "0.2.0"));
  });
  it("rewrites the Cargo package version without touching dependency versions", () => {
    const cargo = [
      '[package]',
      'name = "oxbit-desktop"',
      'version = "0.1.0"',
      'rust-version = "1.97.1"',
      '',
      '[dependencies]',
      'tauri = { version = "2.9.5" }',
      '',
    ].join("\n");
    const bumped = setVersion("apps/desktop/src-tauri/Cargo.toml", cargo, "0.1.2");
    expect(bumped).toContain('version = "0.1.2"');
    expect(bumped).toContain('tauri = { version = "2.9.5" }');
    expect(bumped).not.toContain('version = "0.1.0"');
  });
  it("rewrites the crate that matches the lock file's own app", () => {
    const lock = [
      '[[package]]', 'name = "oxbit-desktop"', 'version = "0.1.0"', '',
      '[[package]]', 'name = "oxbit-ios"', 'version = "0.1.0"', '',
    ].join("\n");
    expect(setVersion("apps/ios/src-tauri/Cargo.lock", lock, "0.2.0")).toContain(
      'name = "oxbit-ios"\nversion = "0.2.0"',
    );
    expect(setVersion("apps/ios/src-tauri/Cargo.lock", lock, "0.2.0")).toContain(
      'name = "oxbit-desktop"\nversion = "0.1.0"',
    );
    expect(setVersion("apps/desktop/src-tauri/Cargo.lock", lock, "0.2.0")).toContain(
      'name = "oxbit-desktop"\nversion = "0.2.0"',
    );
  });
  it("rewrites only the oxbit-desktop entry in the lock file", () => {
    const lock = [
      '[[package]]',
      'name = "objc2"',
      'version = "0.1.0"',
      '',
      '[[package]]',
      'name = "oxbit-desktop"',
      'version = "0.1.0"',
      '',
    ].join("\n");
    const bumped = setVersion("apps/desktop/src-tauri/Cargo.lock", lock, "0.1.2");
    expect(bumped).toBe(
      lock.replace('name = "oxbit-desktop"\nversion = "0.1.0"', 'name = "oxbit-desktop"\nversion = "0.1.2"'),
    );
  });
  it("is a no-op when the file already carries the target version", () => {
    for (const [file, text] of [
      ["package.json", '{"version": "0.1.2"}'],
      ["apps/desktop/src-tauri/Cargo.toml", '[package]\nversion = "0.1.2"\n'],
      ["apps/desktop/src-tauri/Cargo.lock", 'name = "oxbit-desktop"\nversion = "0.1.2"\n'],
    ] as const)
      expect(setVersion(file, text, "0.1.2")).toBe(text);
  });
  it("rejects a file with no version to rewrite", () => {
    expect(() => setVersion("package.json", "{}", "0.1.2")).toThrow("No version field");
    expect(() => setVersion("README.md", "text", "0.1.2")).toThrow("No version rule");
  });
  it("keeps every declared target on the root version in the checked-in tree", async () => {
    const root = JSON.parse(await fs.readFile("package.json", "utf8")).version;
    for (const file of versionFiles as string[]) {
      const text = await fs.readFile(file, "utf8");
      expect(setVersion(file, text, root), file).toBe(text);
    }
  });
});

describe("release git guards", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0))
      await fs.rm(root, { recursive: true, force: true });
  });
  async function repository() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-release-"));
    roots.push(root);
    const at = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    at("init", "--initial-branch=main");
    at("config", "user.name", "Oxbit Test");
    at("config", "user.email", "oxbit@example.test");
    await fs.writeFile(path.join(root, "package.json"), '{"version": "0.1.1"}\n');
    await fs.writeFile(path.join(root, "notes.txt"), "kept\n");
    at("add", "-A");
    at("commit", "-m", "Initial commit");
    return { root, at };
  }

  it("refuses to release from a dirty tree or onto an existing tag", async () => {
    const { root, at } = await repository();
    expect(() => assertReleasable(root, "v0.1.2")).not.toThrow();
    await fs.writeFile(path.join(root, "notes.txt"), "edited\n");
    expect(() => assertReleasable(root, "v0.1.2")).toThrow("Commit or stash");
    at("checkout", "--", "notes.txt");
    at("tag", "v0.1.2");
    expect(() => assertReleasable(root, "v0.1.2")).toThrow("already exists");
    expect(() => assertReleasable(root, "v0.1.3")).not.toThrow();
  });

  it("commits only the version files and annotates the tag", async () => {
    const { root, at } = await repository();
    await fs.writeFile(path.join(root, "package.json"), '{"version": "0.1.2"}\n');
    await fs.writeFile(path.join(root, "notes.txt"), "regenerated by the build\n");
    const dirty = commitRelease(root, "0.1.2", ["package.json"], true);
    expect(dirty).toBe(" M notes.txt");
    expect(at("log", "-1", "--pretty=%s")).toBe("Release v0.1.2");
    expect(at("show", "--stat", "--pretty=", "HEAD")).toContain("package.json");
    expect(at("show", "--stat", "--pretty=", "HEAD")).not.toContain("notes.txt");
    expect(at("cat-file", "-t", "v0.1.2")).toBe("tag");
    expect(at("tag", "-l", "--format=%(contents:subject)", "v0.1.2")).toBe("Oxbit 0.1.2");
  });

  it("leaves no tag behind when the tag flag is off", async () => {
    const { root, at } = await repository();
    await fs.writeFile(path.join(root, "package.json"), '{"version": "0.1.2"}\n');
    expect(commitRelease(root, "0.1.2", ["package.json"], false)).toBe("");
    expect(at("tag", "--list")).toBe("");
  });
});

describe("desktop artifact collection", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0))
      await fs.rm(root, { recursive: true, force: true });
  });

  it("takes this run's installers and leaves intermediates, helpers and earlier versions", async () => {
    const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-bundle-"));
    roots.push(bundle);
    const stale = Date.now() - 60 * 60 * 1000;
    const write = async (name: string, old = false) => {
      const file = path.join(bundle, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, name);
      if (old) await fs.utimes(file, new Date(stale), new Date(stale));
    };
    await write("dmg/Oxbit_0.1.2_aarch64.dmg");
    await write("dmg/bundle_dmg.sh");
    await write("dmg/icon.icns");
    await write("dmg/Oxbit_0.1.1_aarch64.dmg", true);
    await write("macos/Oxbit.app.tar.gz");
    await write("macos/Oxbit.app.tar.gz.sig");
    await write("macos/rw.17261.Oxbit_0.1.0_aarch64.dmg");
    await write("macos/Oxbit.app/Contents/Resources/runtime/remote/darwin-arm64.tar.gz");
    await write("deb/oxbit_0.1.2_amd64.deb");
    await write("appimage/oxbit_0.1.2_amd64.AppImage");

    const collected = (await desktopArtifacts(Date.now() - 60_000, bundle))
      .map((file: string) => path.relative(bundle, file).split(path.sep).join("/"))
      .sort();
    expect(collected).toEqual([
      "appimage/oxbit_0.1.2_amd64.AppImage",
      "deb/oxbit_0.1.2_amd64.deb",
      "dmg/Oxbit_0.1.2_aarch64.dmg",
      "macos/Oxbit.app.tar.gz",
      "macos/Oxbit.app.tar.gz.sig",
    ]);
  });

  it("returns nothing when the bundle directory was never created", async () => {
    expect(await desktopArtifacts(0, path.join(os.tmpdir(), "oxbit-missing-bundle"))).toEqual([]);
  });
});

describe("updater signing preflight", () => {
  it("asks for the key only when the build emits updater artifacts", () => {
    const withUpdater = { bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: "" } } };
    const withoutUpdater = { bundle: {}, plugins: { updater: { pubkey: "" } } };
    expect(updaterKeyMissing(withUpdater, {})).toBe(true);
    expect(updaterKeyMissing(withUpdater, { TAURI_SIGNING_PRIVATE_KEY: "~/.tauri/oxbit.key" })).toBe(false);
    expect(updaterKeyMissing(withoutUpdater, {})).toBe(false);
    expect(updaterKeyMissing({}, {})).toBe(false);
  });
  it("matches the checked-in desktop configuration", async () => {
    const tauri = JSON.parse(
      await fs.readFile("apps/desktop/src-tauri/tauri.conf.json", "utf8"),
    );
    expect(updaterKeyMissing(tauri, {})).toBe(false);
  });
});

describe("iOS artifact collection", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0))
      await fs.rm(root, { recursive: true, force: true });
  });

  it("takes this run's IPA and leaves the simulator app and archives", async () => {
    const build = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-ios-"));
    roots.push(build);
    const stale = Date.now() - 60 * 60 * 1000;
    const write = async (name: string, old = false) => {
      const file = path.join(build, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, name);
      if (old) await fs.utimes(file, new Date(stale), new Date(stale));
    };
    await write("arm64/Oxbit.ipa");
    await write("arm64/Oxbit.app/Info.plist");
    await write("arm64-sim/Oxbit.app/Oxbit");
    await write("oxbit-ios_iOS.xcarchive/Products/Oxbit.ipa");
    await write("arm64/Oxbit-old.ipa", true);

    const collected = (await iosArtifacts(Date.now() - 60_000, build)).map((file: string) =>
      path.relative(build, file).split(path.sep).join("/"),
    );
    expect(collected).toEqual(["arm64/Oxbit.ipa"]);
  });

  it("returns nothing before bun run ios:init has generated the project", async () => {
    expect(await iosArtifacts(0, path.join(os.tmpdir(), "oxbit-missing-ios"))).toEqual([]);
  });
});
