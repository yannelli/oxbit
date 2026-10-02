import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = dirname(require.resolve("typescript"));
const libraries = Object.fromEntries(await Promise.all((await readdir(directory)).filter(file => /^lib\..*\.d\.ts$/.test(file)).map(async file => ["/__oxbit_typescript__/" + file, await readFile(join(directory, file), "utf8")])));
const output = join(root, "apps/ios/plugins/oxbit-files/ios/Sources/Resources/language-servers.js");
await mkdir(dirname(output), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ["packages/features/language/src/native/entry.ts"], outfile: output,
  bundle: true, format: "iife", globalName: "OxbitLsp", target: "es2022", platform: "browser", minify: true,
  supported: { "template-literal": false },
  plugins: [{
    name: "bundled-typescript-libraries",
    setup(builder) {
      builder.onResolve({ filter: /^oxbit:typescript-libraries$/ }, () => ({ path: "libraries", namespace: "oxbit-lsp" }));
      builder.onLoad({ filter: /.*/, namespace: "oxbit-lsp" }, () => ({ contents: JSON.stringify(libraries), loader: "json" }));
    },
  }],
});
const script = (await readFile(output, "utf8")).trim();
let delimiter = "########";
while (script.includes('"""' + delimiter)) delimiter += "#";
await writeFile(join(dirname(dirname(output)), "LanguageServerBundle.swift"), `enum LanguageServerBundle {\n  static let script = ${delimiter}"""\n${script}\n"""${delimiter}\n}\n`);
