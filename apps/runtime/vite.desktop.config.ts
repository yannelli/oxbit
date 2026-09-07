import { defineConfig } from "vite";
export default defineConfig({
  ssr: { noExternal: ["@oxbit/protocol", "@oxbit/sdk", "@oxbit/core", "semver"] },
  build: {
    ssr: "src/desktop.ts", outDir: "dist-desktop", target: "node24", sourcemap: false,
    minify: false,
  },
});
