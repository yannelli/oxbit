import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
export default defineConfig({
  define: { __OXBIT_VERSION__: JSON.stringify(version) },
  ssr: { noExternal: ["@oxbit/protocol", "@oxbit/sdk", "@oxbit/core", "@oxbit/agent-core", "@oxbit/agent", "semver"] },
  build: {
    ssr: true, outDir: "dist-desktop", target: "node24", sourcemap: false,
    minify: false,
    rollupOptions: {
      // cli.js runs `oxbit remote` for the desktop app. Shared chunks stay beside the entries
      // because modules resolve bin/, agent/ and remote/ relative to their own file.
      input: { desktop: "src/desktop.ts", cli: "src/index.ts" },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
    },
  },
});
