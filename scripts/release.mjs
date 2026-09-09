import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = `Usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [options]

  --out <dir>    Collect into <dir>/v<version> (default: release)
  --no-desktop   Skip the desktop bundle even when the toolchain is present
  --no-ios       Skip the iOS IPA even when Xcode and a signing identity are present
  --check        Run pnpm lint and pnpm test first (pnpm build already runs tsc -b)
  --commit       Commit the bumped version files
  --tag          Create the annotated tag v<version> (implies --commit)
  --dry-run      Print the plan and write nothing
`;

/** Root package.json is the release version; both tauri.conf.json files read it and the v<version> tag must match it. */
export const versionFiles = [
  "package.json",
  "apps/runtime/package.json",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/Cargo.toml",
  "apps/desktop/src-tauri/Cargo.lock",
  "apps/ios/package.json",
  "apps/ios/src-tauri/Cargo.toml",
  "apps/ios/src-tauri/Cargo.lock",
];

export function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isInteger(value)))
    throw new Error(`Cannot bump the non-semver version ${current}`);
  const [major, minor, patch] = parts;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Choose patch, minor, major, or an explicit X.Y.Z, not ${bump}`);
}

/** Each app's lock file carries one oxbit-<app> crate; the surrounding entries belong to dependencies. */
function versionPattern(file) {
  if (/Cargo\.lock$/.test(file)) {
    const app = file.split("/")[1];
    return new RegExp(`(name = "oxbit-${app}"\\nversion = ")[^"]*(")`);
  }
  if (/Cargo\.toml$/.test(file)) return /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]*(")/;
  if (/\.json$/.test(file)) return /("version"\s*:\s*")[^"]*(")/;
  return undefined;
}
export function setVersion(file, text, version) {
  const pattern = versionPattern(file);
  if (!pattern) throw new Error(`No version rule for ${file}`);
  if (!pattern.test(text)) throw new Error(`No version field in ${file}`);
  return text.replace(pattern, `$1${version}$2`);
}

/** Tauri signs the updater artifacts at the end of a long build, so the key is checked before the bump. */
export function updaterKeyMissing(tauriConfig, env) {
  return Boolean(tauriConfig.bundle?.createUpdaterArtifacts) && !env.TAURI_SIGNING_PRIVATE_KEY;
}

const run = (command, args, env = {}, without = []) => {
  const merged = { ...process.env, ...env };
  // Tauri signs with an empty identity when the variable is present but blank, so it has to be deleted.
  for (const name of without) delete merged[name];
  return execFileSync(command, args, { cwd: root, stdio: "inherit", env: merged });
};
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function assertReleasable(cwd, tag) {
  const at = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (at("status", "--porcelain"))
    throw new Error("Commit or stash your changes before --commit or --tag");
  if (at("tag", "--list", tag)) throw new Error(`Tag ${tag} already exists`);
}

/** Only the bumped files are staged; the build also rewrites tracked generated files such as apps/web/public/sdk/index.js. */
export function commitRelease(cwd, version, files, annotate) {
  const at = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  at("add", "--", ...files);
  at("commit", "-m", `Release v${version}`);
  if (annotate) at("tag", "-a", `v${version}`, "-m", `Oxbit ${version}`);
  // Porcelain status columns are leading characters, so this one is not trimmed.
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trimEnd();
}

async function hash(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
async function walk(directory, skip) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skip?.(entry.name)) found.push(...(await walk(full, skip)));
    } else if (entry.isFile()) found.push(full);
  }
  return found;
}
async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

/** Xcode keeps simulator builds and archives beside the export; the IPA is the installable product. */
export async function iosArtifacts(since, buildRoot) {
  const build = buildRoot ?? path.join(root, "apps/ios/src-tauri/gen/apple/build");
  if (!(await exists(build))) return [];
  const collected = [];
  for (const file of await walk(build, (name) => name.endsWith(".app") || name.endsWith(".xcarchive")))
    if (file.endsWith(".ipa") && (await fs.stat(file)).mtimeMs + 1000 >= since) collected.push(file);
  return collected;
}

/** Tauri leaves earlier versions and its own intermediates in bundle/; only this run's output belongs in the release. */
export async function desktopArtifacts(since, bundleRoot) {
  const bundle = bundleRoot ?? path.join(root, "apps/desktop/src-tauri/target/release/bundle");
  if (!(await exists(bundle))) return [];
  const collected = [];
  // Oxbit.app holds the whole staged runtime; the installers beside it are the distributables.
  for (const file of await walk(bundle, (name) => name.endsWith(".app"))) {
    if (!/\.(dmg|deb|AppImage|app\.tar\.gz|sig)$/.test(file)) continue;
    if (path.basename(file).startsWith("rw.")) continue;
    if ((await fs.stat(file)).mtimeMs + 1000 < since) continue;
    collected.push(file);
  }
  return collected;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: "release" },
      "no-desktop": { type: "boolean", default: false },
      "no-ios": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      commit: { type: "boolean", default: false },
      tag: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(usage);
    process.exit(values.help ? 0 : 1);
  }
  const commit = values.commit || values.tag;
  const manifestPath = path.join(root, "package.json");
  const current = JSON.parse(await fs.readFile(manifestPath, "utf8")).version;
  const version = nextVersion(current, positionals[0]);
  const tag = `v${version}`;
  const output = path.resolve(root, values.out, tag);
  if (!output.startsWith(path.resolve(root, values.out) + path.sep))
    throw new Error(`Refusing to write outside ${values.out}`);

  if (commit) assertReleasable(root, tag);

  const shown = output.startsWith(root) ? path.relative(root, output) : output;
  const platform = `${process.platform}-${process.arch}`;
  const supportedHost = ["darwin-arm64", "linux-x64"].includes(platform);
  const hasCargo = spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0;
  const wanted = !values["no-desktop"];
  const desktop = wanted && supportedHost && hasCargo;
  const desktopSkip = !wanted
    ? "disabled with --no-desktop"
    : !supportedHost
      ? `unsupported host ${platform}`
      : !hasCargo
        ? "cargo is not on PATH"
        : undefined;

  // Ambient Apple credentials override tauri.conf.json and add a notarization round trip.
  // Notarized artifacts come from desktop:release and the tagged CI build.
  const appleEnv = [
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_KEYCHAIN_PROFILE",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_PATH",
  ].filter((name) => process.env[name]);

  const tauri = JSON.parse(
    await fs.readFile(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  const signingIdentity =
    process.platform === "darwin" ? tauri.bundle?.macOS?.signingIdentity : undefined;
  if (desktop && updaterKeyMissing(tauri, process.env))
    throw new Error(
      "createUpdaterArtifacts in tauri.conf.json makes desktop:build sign its artifacts. Set TAURI_SIGNING_PRIVATE_KEY or pass --no-desktop.",
    );

  const wantsIos = !values["no-ios"];
  // xcode-select often points at the Command Line Tools; scripts/ios/run.mjs redirects DEVELOPER_DIR the same way.
  const hasXcode =
    process.platform === "darwin" &&
    (Boolean(process.env.DEVELOPER_DIR) ||
      (await exists("/Applications/Xcode.app")) ||
      (await exists("/Applications/Xcode-beta.app")));
  const iosProject = await exists(path.join(root, "apps/ios/src-tauri/gen/apple"));
  // ios:build exports with app-store-connect, which needs a distribution certificate in the keychain.
  const iosIdentity =
    hasXcode &&
    spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" })
      .stdout?.includes("Apple Distribution:");
  const ios = wantsIos && hasXcode && iosProject && Boolean(iosIdentity);
  const iosSkip = !wantsIos
    ? "disabled with --no-ios"
    : !hasXcode
      ? "xcodebuild is not available"
      : !iosProject
        ? "run pnpm ios:init first"
        : !iosIdentity
          ? "no Apple Distribution signing identity"
          : undefined;

  const originals = new Map();
  const updates = new Map();
  for (const file of versionFiles) {
    const text = await fs.readFile(path.join(root, file), "utf8");
    originals.set(file, text);
    updates.set(file, setVersion(file, text, version));
  }

  if (commit && [...updates].every(([file, text]) => text === originals.get(file)))
    throw new Error(`Every version file already reads ${version}; nothing to commit`);

  // CI builds on the pinned runtime, so a different one here can produce different artifacts.
  const pinned = (await fs.readFile(path.join(root, ".node-version"), "utf8")).trim();
  if (pinned.split(".")[0] !== process.version.slice(1).split(".")[0])
    console.log(`Warning: building on Node ${process.version.slice(1)}; .node-version pins ${pinned}`);

  console.log(`Oxbit ${current} -> ${version}`);
  for (const file of versionFiles) console.log(`  bump ${file}`);
  console.log(`  build web, runtime, SDK and the example extension`);
  console.log(desktop ? "  build the desktop bundle" : `  skip the desktop bundle (${desktopSkip})`);
  if (desktop && appleEnv.length)
    console.log(
      `  ignore ${appleEnv.join(", ")} so the desktop bundle is not notarized`,
    );
  console.log(ios ? "  build the iOS IPA" : `  skip the iOS IPA (${iosSkip})`);
  console.log(`  collect into ${shown}`);
  if (commit) console.log(values.tag ? `  commit and tag ${tag}` : "  commit the version files");
  if (values["dry-run"]) return;

  for (const [file, text] of updates)
    await fs.writeFile(path.join(root, file), text);

  try {
    if (values.check) {
      run("pnpm", ["lint"]);
      run("pnpm", ["test"]);
    }
    run("pnpm", ["build"]);
    const started = Date.now();
    if (desktop)
      run(
        "pnpm",
        ["desktop:build"],
        // remote/prepare.mjs otherwise cross-builds the other platform through docker.
        { OXBIT_REMOTE_TARGETS: process.env.OXBIT_REMOTE_TARGETS ?? platform },
        appleEnv,
      );
    // The App Store Connect export needs the signing environment that the desktop step drops.
    if (ios) run("pnpm", ["ios:build"]);

    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true });
    const groups = [];
    const copyTree = async (name, from) => {
      if (!(await exists(path.join(root, from)))) return;
      await fs.cp(path.join(root, from), path.join(output, name), { recursive: true });
      groups.push({ name, source: from });
    };
    await copyTree("web", "apps/web/dist");
    await copyTree("runtime", "apps/runtime/dist");
    await copyTree("extensions", "examples/bundle-inspector/dist");
    const packs = (await exists(path.join(root, "examples/icon-packs")))
      ? (await fs.readdir(path.join(root, "examples/icon-packs"))).filter((name) => name.endsWith(".zip"))
      : [];
    if (packs.length) {
      await fs.mkdir(path.join(output, "icon-packs"));
      for (const name of packs)
        await fs.copyFile(path.join(root, "examples/icon-packs", name), path.join(output, "icon-packs", name));
      groups.push({ name: "icon-packs", source: "examples/icon-packs" });
    }
    const collect = async (name, files, source) => {
      if (!files.length) return;
      await fs.mkdir(path.join(output, name));
      for (const file of files)
        await fs.copyFile(file, path.join(output, name, path.basename(file)));
      groups.push({ name, source });
    };
    const installers = desktop ? await desktopArtifacts(started) : [];
    await collect("desktop", installers, "apps/desktop/src-tauri/target/release/bundle");
    if (desktop && !installers.length)
      throw new Error("The desktop build produced no installers");
    const packages = ios ? await iosArtifacts(started) : [];
    await collect("ios", packages, "apps/ios/src-tauri/gen/apple/build");
    if (ios && !packages.length) throw new Error("The iOS build produced no IPA");

    const files = (await walk(output)).sort();
    const entries = [];
    for (const file of files)
      entries.push({
        path: path.relative(output, file).split(path.sep).join("/"),
        bytes: (await fs.stat(file)).size,
        sha256: await hash(file),
      });
    const shipped = JSON.parse(await fs.readFile(manifestPath, "utf8")).version;
    if (shipped !== version)
      throw new Error(`Root package.json reads ${shipped} after the build; expected ${version}`);
    await fs.writeFile(
      path.join(output, "SHA256SUMS"),
      entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""),
    );
    await fs.writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify(
        {
          name: "oxbit",
          version,
          tag,
          created: new Date().toISOString(),
          commit: git("rev-parse", "HEAD"),
          node: process.version,
          host: platform,
          desktop: desktop
            ? {
                included: true,
                command: "pnpm desktop:build",
                signingIdentity: signingIdentity ?? null,
                notarized: false,
                note: "Notarized distribution artifacts come from pnpm desktop:release and the tagged CI build in .github/workflows/desktop.yml",
              }
            : { included: false, reason: desktopSkip },
          ios: ios
            ? {
                included: true,
                command: "pnpm ios:build",
                exportMethod: "app-store-connect",
                note: "TestFlight uploads run through pnpm ios:upload and .github/workflows/ios.yml",
              }
            : { included: false, reason: iosSkip },
          groups: groups.map((group) => ({
            ...group,
            files: entries.filter((entry) => entry.path.startsWith(`${group.name}/`)).length,
            bytes: entries
              .filter((entry) => entry.path.startsWith(`${group.name}/`))
              .reduce((total, entry) => total + entry.bytes, 0),
          })),
          artifacts: entries.filter((entry) => /^(desktop|ios|icon-packs)\//.test(entry.path)),
        },
        null,
        2,
      ) + "\n",
    );

    if (commit) {
      const dirty = commitRelease(root, version, versionFiles, values.tag);
      if (dirty) console.log(`Build left tracked files uncommitted:\n${dirty}`);
    }

    const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const group of groups) console.log(`  ${group.name}/`);
    console.log(
      `Wrote ${entries.length} files (${(total / 1024 / 1024).toFixed(1)} MB) to ${shown}`,
    );
    if (values.tag) console.log(`Push with: git push --follow-tags`);
  } catch (error) {
    for (const [file, text] of originals)
      await fs.writeFile(path.join(root, file), text);
    console.error(`Restored ${versionFiles.length} version files after the failure below.`);
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
