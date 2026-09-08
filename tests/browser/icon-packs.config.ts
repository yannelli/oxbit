import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'icon-packs.spec.ts', workers: 1, timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['json', { outputFile: '../../evidence/icon-packs/browser-results.json' }]],
  outputDir: '../../evidence/icon-packs/browser-artifacts',
  use: { baseURL: 'http://127.0.0.1:9381', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node scripts/serve-icon-tests.mjs', url: 'http://127.0.0.1:9381', reuseExistingServer: false, timeout: 90000, cwd: '../..' },
});
