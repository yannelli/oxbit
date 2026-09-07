import { defineConfig } from "vite";
export default defineConfig({
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
