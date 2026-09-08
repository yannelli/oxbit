import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
await mkdir("apps/web/public/sdk", { recursive: true });
// index.ts re-exports sibling modules, so the browser entry has to be bundled.
await build({
  entryPoints: ["packages/sdk/src/index.ts"],
  outfile: "apps/web/public/sdk/index.js",
  bundle: true,
  format: "esm",
  target: "es2023",
  platform: "browser",
  external: ["react", "react-dom"],
});
await copyFile("LICENSE", "apps/web/public/LICENSE.txt");
