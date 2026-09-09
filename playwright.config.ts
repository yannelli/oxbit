import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  // themes.spec.ts and icon-packs.spec.ts have their own configs and servers.
  testIgnore: ["themes.spec.ts", "icon-packs.spec.ts", "tasks.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "evidence/browser-results.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:9278",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", testIgnore: ["mobile.spec.ts"], use: { browserName: "chromium" } },
    // WebKit with a touch-first phone profile approximates WKWebView before device checks.
    {
      name: "webkit-phone",
      testMatch: ["mobile.spec.ts"],
      use: { ...devices["iPhone 15"], browserName: "webkit", hasTouch: true, isMobile: true, viewport: { width: 393, height: 852 } },
    },
  ],
  webServer: {
    command: "node scripts/start-e2e.mjs",
    url: "http://127.0.0.1:9278/api/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
