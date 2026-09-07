import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  css: { transformer: "lightningcss" },
  server: {
    host: "0.0.0.0",
    port: 9279,
    proxy: {
      "/api": "http://127.0.0.1:9277",
      "/ws": { target: "ws://127.0.0.1:9277", ws: true },
    },
  },
  build: {
    cssMinify: "lightningcss",
    target: "es2023",
    sourcemap: true,
    chunkSizeWarningLimit: 1400,
  },
  worker: { format: "es" },
});
