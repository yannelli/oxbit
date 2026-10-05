import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = `Usage: node scripts/npm/publish.mjs <sdk|cli> [options]

  --expect-tag <tag>  Fail unless <tag> is v<package version>
  --dry-run           Stage and run npm publish --dry-run
`;

export const distTag = (version) => (version.includes("-") ? "next" : "latest");

export const versionUrl = (name, version) =>
  `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`;

export function assertTag(tag, version) {
  if (tag !== `v${version}`)
    throw new Error(`Tag ${tag} does not match package version ${version}`);
}

/** Workspace packages are bundled into the runtime; the rest install from npm at the versions CI built with. */
export function pinnedDependencies(dependencies, installedVersion) {
  return Object.fromEntries(
    Object.keys(dependencies)
      .filter((name) => !name.startsWith("@oxbit/"))
      .sort()
      .map((name) => [name, installedVersion(name)]),
  );
}

function shared(source, directory) {
  return {
    license: source.license,
    author: source.author,
    homepage: "https://github.com/yannelli/oxbit#readme",
    bugs: "https://github.com/yannelli/oxbit/issues",
    repository: { type: "git", url: "git+https://github.com/yannelli/oxbit.git", directory },
    publishConfig: { access: "public" },
  };
}

export function sdkManifest(source) {
  return {
    name: source.name,
    version: source.version,
    description: "Extension SDK for the Oxbit code editor",
    type: "module",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    types: "./dist/index.d.ts",
    files: ["dist"],
    sideEffects: false,
    peerDependencies: { "@types/react": "^19.1.0", react: "^19.1.0" },
    peerDependenciesMeta: { "@types/react": { optional: true }, react: { optional: true } },
    ...shared(source, "packages/sdk"),
  };
}

export function cliManifest(app, runtime, installedVersion) {
  return {
    name: "@oxbit/cli",
    version: app.version,
    description: "The oxbit command: runs the Oxbit runtime and opens the editor in a browser",
    type: "module",
    bin: { oxbit: "runtime/dist/index.js" },
    files: ["runtime", "web", "scripts"],
    scripts: { postinstall: "node scripts/repair-pty.mjs" },
    os: ["darwin", "linux"],
    engines: app.engines,
    dependencies: pinnedDependencies(runtime.dependencies, installedVersion),
    ...shared(app, "apps/runtime"),
  };
}

const readJson = async (file) => JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");

function installedVersion(name) {
  for (const directory of ["apps/runtime", "."]) {
    const manifest = path.join(root, directory, "node_modules", name, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
  }
  throw new Error(`${name} is not installed. Run bun install --frozen-lockfile.`);
}

async function stageSdk(stage) {
  const source = await readJson("packages/sdk/package.json");
  const index = await fs.readFile(path.join(root, "packages/sdk/src/index.ts"), "utf8");
  const declared = index.match(/SDK_VERSION = "([^"]+)"/)?.[1];
  if (declared !== source.version)
    throw new Error(`SDK_VERSION ${declared} does not match packages/sdk/package.json ${source.version}`);
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("vite"))("esbuild");
  await build({
    entryPoints: [path.join(root, "packages/sdk/src/index.ts")],
    outfile: path.join(stage, "dist/index.js"),
    bundle: true,
    format: "esm",
    target: "es2023",
    platform: "neutral",
    external: ["react", "react-dom"],
  });
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-b", "packages/sdk"], {
    cwd: root,
    stdio: "inherit",
  });
  await fs.cp(path.join(root, "packages/sdk/dist-types"), path.join(stage, "dist"), {
    recursive: true,
    filter: async (entry) => entry.endsWith(".d.ts") || (await fs.stat(entry)).isDirectory(),
  });
  await fs.copyFile(path.join(root, "packages/sdk/README.md"), path.join(stage, "README.md"));
  return sdkManifest(source);
}

async function stageCli(stage) {
  const app = await readJson("package.json");
  const runtime = await readJson("apps/runtime/package.json");
  if (runtime.version !== app.version)
    throw new Error(`apps/runtime/package.json ${runtime.version} does not match package.json ${app.version}`);
  for (const file of ["apps/runtime/dist/index.js", "apps/web/dist/index.html"])
    if (!existsSync(path.join(root, file))) throw new Error(`Missing ${file}. Run bun run build.`);
  const withoutMaps = (entry) => !entry.endsWith(".map");
  await fs.cp(path.join(root, "apps/runtime/dist"), path.join(stage, "runtime/dist"), {
    recursive: true,
    filter: withoutMaps,
  });
  await fs.cp(path.join(root, "apps/web/dist"), path.join(stage, "web/dist"), {
    recursive: true,
    filter: withoutMaps,
  });
  // cli.ts reads the version from ../package.json, and runtime.ts serves ../../web/dist/, relative to the bundle.
  await writeJson(path.join(stage, "runtime/package.json"), {
    name: "@oxbit/runtime",
    version: app.version,
    private: true,
    type: "module",
  });
  await fs.mkdir(path.join(stage, "scripts"));
  await fs.copyFile(path.join(root, "scripts/repair-pty.mjs"), path.join(stage, "scripts/repair-pty.mjs"));
  await fs.copyFile(path.join(root, "apps/runtime/README.md"), path.join(stage, "README.md"));
  return cliManifest(app, runtime, installedVersion);
}

/** The package document of a new package stays a cached 404 for minutes after its first publish; the version document does not. */
async function isPublished(name, version) {
  const response = await fetch(versionUrl(name, version));
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`The npm registry returned ${response.status} for ${name}@${version}`);
  return true;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "expect-tag": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const [target] = positionals;
  if (target !== "sdk" && target !== "cli") throw new Error(usage);
  const name = `@oxbit/${target}`;
  const { version } = await readJson(target === "sdk" ? "packages/sdk/package.json" : "package.json");
  if (values["expect-tag"] !== undefined) assertTag(values["expect-tag"], version);
  if (!values["dry-run"] && (await isPublished(name, version))) {
    console.log(`${name}@${version} is already on npm`);
    return;
  }

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), `oxbit-npm-${target}-`));
  const manifest = target === "sdk" ? await stageSdk(stage) : await stageCli(stage);
  await writeJson(path.join(stage, "package.json"), manifest);
  await fs.copyFile(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
  console.log(`Staged ${name}@${version} in ${stage}`);

  const args = ["publish", stage, "--access", "public", "--tag", distTag(version)];
  args.push(values["dry-run"] ? "--dry-run" : "--provenance");
  execFileSync("npm", args, { stdio: "inherit" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
