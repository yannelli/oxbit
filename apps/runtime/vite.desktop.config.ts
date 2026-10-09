import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
export default defineConfig({
  define: { __OXBIT_VERSION__: JSON.stringify(version) },
  ssr: { noExternal: ["@oxbit/protocol", "@oxbit/sdk", "@oxbit/core", "semver"] },
  build: {
    ssr: "src/desktop.ts", outDir: "dist-desktop", target: "node24", sourcemap: false,
    minify: false,
  },
});
