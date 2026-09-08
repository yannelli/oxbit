import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "tasks.spec.ts",
  outputDir: fileURLToPath(
    new URL("../../test-results/tasks", import.meta.url),
  ),
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: fileURLToPath(
          new URL("../../evidence/tasks/browser-results.json", import.meta.url),
        ),
      },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:9286",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command:
      "node node_modules/tsx/dist/cli.mjs scripts/tasks/browser-server.ts",
    url: "http://127.0.0.1:9286/api/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
