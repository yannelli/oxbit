import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
export default defineConfig({
  plugins: [{
    name: "runtime-cli-permissions",
    async writeBundle(options, bundle) {
      // Global npm links point here, and rebuilding replaces the executable file.
      for (const file of Object.values(bundle))
        if (file.type === "chunk" && file.isEntry)
          await chmod(resolve(options.dir ?? "dist", file.fileName), 0o755);
    },
  }],
  define: { __OXBIT_VERSION__: JSON.stringify(version) },
  ssr: { noExternal: ["@oxbit/protocol", "@oxbit/sdk", "@oxbit/core", "semver"] },
  build: {
    ssr: "src/index.ts",
    outDir: "dist",
    target: "node24",
    sourcemap: true,
    minify: false,
    rollupOptions: { output: { banner: "#!/usr/bin/env node" } },
  },
});
