import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../../test-results/ios",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    baseURL: "http://127.0.0.1:9281",
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    launchOptions: { executablePath: process.env.CHROME_EXECUTABLE },
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: fileURLToPath(new URL("../../apps/ios", import.meta.url)),
    command: "bun run dev",
    url: "http://127.0.0.1:9281",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
