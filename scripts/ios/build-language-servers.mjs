import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const root = fileURLToPath(new URL("../../", import.meta.url));
const language = join(root, "packages/features/language");
const resolve = (specifier) => createRequire(join(language, "package.json")).resolve(specifier);
const packageFile = (name, file) => {
  let directory = dirname(resolve(name));
  while (!existsSync(join(directory, "package.json"))) directory = dirname(directory);
  return join(directory, file);
};
const directory = dirname(require.resolve("typescript"));
const libraries = Object.fromEntries(await Promise.all((await readdir(directory)).filter(file => /^lib\..*\.d\.ts$/.test(file)).map(async file => ["/__oxbit_typescript__/" + file, await readFile(join(directory, file), "utf8")])));
/** The Xcode project copies this folder reference into the app bundle as `assets/`. */
const output = join(root, "apps/ios/src-tauri/gen/apple/assets/language-servers");
const kinds = ["typescript", "json", "yaml", "dockerfile", "shell", "python"];
/** Bundled binary assets per kind, served to JavaScript through the host `resource` callback. */
const assets = {
  shell: [packageFile("bash-language-server", "tree-sitter-bash.wasm"), packageFile("web-tree-sitter", "web-tree-sitter.wasm"), packageFile("@wasm-fmt/shfmt", "shfmt.wasm")],
  python: [packageFile("@astral-sh/ruff-wasm-web", "ruff_wasm_bg.wasm"), join(dirname(resolve("browser-basedpyright/package.json")), "dist/pyright.worker.js")],
};
/** Node built-ins that servers import but do not need on device resolve to browser modules or empty stubs. */
const browserModules = { path: resolve("path-browserify") };
const stubs = new Set(["fs", "fs/promises", "child_process", "os", "https", "http", "net", "url", "util", "crypto", "stream", "events", "worker_threads", "perf_hooks", "readline", "zlib", "tty", "assert", "inspector", "buffer", "module", "vm"]);
/** Package imports replaced per kind: a string aliases to another package, `null` resolves to an empty stub. */
const packageAliases = {
  shell: { "vscode-languageserver/node": "vscode-languageserver", "fast-glob": null },
};

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "schemas"), { recursive: true });
const sizes = {};
/** Package directories bundled per kind, for the license notices. */
const bundled = {};
for (const kind of kinds) {
  const entry = join(language, `src/native/entries/${kind}.ts`);
  if (!existsSync(entry)) continue;
  const outfile = join(output, `${kind}.js`);
  const result = await build({
    absWorkingDir: root, metafile: true, entryPoints: [entry], outfile,
    bundle: true, format: "iife", globalName: "OxbitLsp", target: "es2022", platform: "browser", minify: true,
    mainFields: ["browser", "module", "main"], conditions: ["browser"], legalComments: "none",
    supported: { "template-literal": false },
    logLevel: "warning",
    plugins: [{
      name: "oxbit-native-language",
      setup(builder) {
        builder.onResolve({ filter: /^oxbit:typescript-libraries$/ }, () => ({ path: "libraries", namespace: "oxbit-lsp" }));
        builder.onLoad({ filter: /.*/, namespace: "oxbit-lsp" }, () => ({ contents: JSON.stringify(libraries), loader: "json" }));
        for (const [specifier, target] of Object.entries(packageAliases[kind] ?? {})) {
          builder.onResolve({ filter: new RegExp(`^${specifier.replace(/[.\/-]/g, "\\$&")}$`) }, async args => target === null
            ? { path: specifier, namespace: "oxbit-stub" }
            : { path: (await builder.resolve(target, { kind: args.kind, resolveDir: args.resolveDir })).path });
        }
        builder.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, args => {
          const name = args.path.replace(/^node:/, "");
          if (!builtinModules.includes(name)) return undefined;
          if (browserModules[name]) return { path: browserModules[name] };
          if (stubs.has(name)) return { path: name, namespace: "oxbit-stub" };
          throw new Error(`${args.importer} imports Node built-in "${name}". Add a browser module or stub in build-language-servers.mjs.`);
        });
        builder.onLoad({ filter: /.*/, namespace: "oxbit-stub" }, () => ({ contents: "module.exports = {};", loader: "js" }));
      },
    }],
  });
  bundled[kind] = [...new Set([...Object.keys(result.metafile.inputs).map(file => join(root, file)), ...(assets[kind] ?? [])]
    .map(file => /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1]).filter(Boolean))].sort();
  for (const asset of assets[kind] ?? []) await copyFile(asset, join(output, asset.split("/").at(-1)));
  sizes[kind] = (await stat(outfile)).size + (await Promise.all((assets[kind] ?? []).map(asset => stat(asset)))).reduce((total, item) => total + item.size, 0);
}
const schemas = join(language, "schemas");
for (const file of await readdir(schemas)) await copyFile(join(schemas, file), join(output, "schemas", file));
if (process.env.OXBIT_LANGUAGE_SIZES) console.log(JSON.stringify(sizes));
export { bundled };
