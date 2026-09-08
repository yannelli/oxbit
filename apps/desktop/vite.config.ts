import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()], publicDir: "../web/public", clearScreen: false,
  server: { host: "127.0.0.1", port: 9280, strictPort: true },
  css: { transformer: "lightningcss" },
  build: { target: "es2022", cssMinify: "lightningcss", sourcemap: false, chunkSizeWarningLimit: 1800 },
  worker: { format: "es" },
});
