import { config as base } from './wdio.conf.mjs';
import path from 'node:path';
const binary = path.resolve('apps/desktop/src-tauri/target/debug/oxbit-icon-test');
export const config = { ...base, specs: [process.env.OXBIT_ICON_RESTART ? './icon-packs-restart.e2e.mjs' : './icon-packs.e2e.mjs'], capabilities: [{ browserName: 'tauri', 'tauri:options': { application: binary } }],
  services: [['@wdio/tauri-service', { appBinaryPath: binary, driverProvider: 'embedded', embeddedPort: 4461, captureBackendLogs: true, captureFrontendLogs: true, logDir: path.resolve('evidence/icon-packs/native'), startTimeout: 60000 }]],
  onComplete: async () => { if (!process.env.OXBIT_ICON_KEEP) await base.onComplete(); },
  outputDir: path.resolve('evidence/icon-packs/native'), mochaOpts: { timeout: 120000 },
};
