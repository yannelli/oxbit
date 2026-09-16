import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
await mkdir("evidence/language-milestone1", { recursive: true });
for (const name of ["smoke", "intelligence", "project-intelligence"]) await build({
  entryPoints: [`scripts/language/${name}.ts`], bundle: true, platform: "node", format: "esm", target: "node24",
  external: ["typescript"],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  outfile: `evidence/language-milestone1/${name}.mjs`,
});
