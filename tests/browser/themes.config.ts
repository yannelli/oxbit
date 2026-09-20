import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "themes.spec.ts",
  workers: 1,
  webServer: {
    command:
      "bun run --filter @oxbit/web build && bunx tsx scripts/start-theme-tests.mts",
    cwd: "../..",
    url: "http://127.0.0.1:9289",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: "list",
  outputDir: "../../evidence/themes/playwright",
  use: {
    baseURL: "http://127.0.0.1:9289",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
  },
});
