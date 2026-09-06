import { defineConfig } from "vite";
export default defineConfig({
  ssr: { noExternal: ["@zapp/protocol", "@zapp/sdk", "@zapp/core", "semver"] },
  build: {
    ssr: "src/index.ts",
    outDir: "dist",
    target: "node24",
    sourcemap: true,
    minify: false,
  },
});
