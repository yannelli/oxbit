import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../tests/browser", testMatch: ["settings-files.spec.ts"], workers: 1, timeout: 60000,
  expect: { timeout: 15000 }, reporter: [["list"], ["json", { outputFile: "../../evidence/settings-files/browser-results.json" }]],
  outputDir: "../../evidence/settings-files/browser-artifacts",
  use: { baseURL: "http://127.0.0.1:9536", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "bunx tsx scripts/language/browser-runtime.ts", cwd: "../..", url: "http://127.0.0.1:9536/api/health", timeout: 30000, reuseExistingServer: false, env: { OXBIT_LANGUAGE_BROWSER_PORT: "9536" } },
});
