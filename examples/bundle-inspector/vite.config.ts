import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "bundle-inspector.js",
    },
    rollupOptions: { external: ["react"] },
    sourcemap: true,
    target: "es2022",
  },
});
