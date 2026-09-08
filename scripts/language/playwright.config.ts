import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../tests/browser", testMatch: ["language-design.spec.ts", "language-registry.spec.ts", "language-features.spec.ts"], workers: 1, timeout: 120000,
  expect: { timeout: 30000 }, reporter: [["list"], ["json", { outputFile: "../../evidence/language-milestone1/browser-results.json" }]],
  outputDir: "../../evidence/language-milestone1/browser-artifacts",
  use: { baseURL: "http://127.0.0.1:9534", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm exec tsx scripts/language/browser-runtime.ts", cwd: "../..", url: "http://127.0.0.1:9534/api/health", timeout: 30000, reuseExistingServer: false },
});
