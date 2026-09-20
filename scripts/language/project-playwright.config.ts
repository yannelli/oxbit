import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
export default defineConfig({
  testDir: "../../tests/browser", testMatch: ["project-intelligence.spec.ts"], workers: 1, timeout: 120000,
  expect: { timeout: 30000 }, reporter: [["list"], ["json", { outputFile: "../../evidence/project-intelligence/browser-results.json" }]],
  outputDir: "../../evidence/project-intelligence/browser-artifacts",
  use: { baseURL: "http://127.0.0.1:9535", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "bunx tsx scripts/language/browser-runtime.ts", cwd: "../..", url: "http://127.0.0.1:9535/api/health", timeout: 30000, reuseExistingServer: false, env: { OXBIT_LANGUAGE_BROWSER_PORT: "9535", OXBIT_LSP_CACHE: process.env.OXBIT_LSP_CACHE ?? path.join(os.tmpdir(), "oxbit-managed-language-smoke-cache") } },
});
