import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const host = process.env.TAURI_DEV_HOST;
export default defineConfig({
  plugins: [react()], publicDir: "../web/public", clearScreen: false,
  server: {
    host: host || "127.0.0.1", port: 9281, strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 9282 } : undefined,
  },
  css: { transformer: "lightningcss" },
  build: { target: "es2022", cssMinify: "lightningcss", sourcemap: false, chunkSizeWarningLimit: 1800 },
  worker: { format: "es" },
});
