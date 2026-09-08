import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const inheritedFixture = process.env.OXBIT_NATIVE_FIXTURES;
const fixture =
  inheritedFixture ||
  (await fs.mkdtemp(path.join(os.tmpdir(), "Oxbit native café ")));
process.env.OXBIT_DESKTOP_TEST_DATA = path.join(fixture, "Application state");
process.env.OXBIT_NATIVE_FIXTURES = fixture;
if (!inheritedFixture)
  for (const name of ["Alpha project", "Beta 项目", "Gamma project"]) {
    await fs.mkdir(path.join(fixture, name));
    await fs.mkdir(path.join(fixture, name, "src"));
    await fs.writeFile(
      path.join(fixture, name, "src", "nested.ts"),
      "export const nested = 1;\n",
    );
    execFileSync("git", ["init", "-q", path.join(fixture, name)]);
    await fs.writeFile(
      path.join(fixture, name, "hello.ts"),
      'export const greeting = "hello";\n',
    );
  }
const binary =
  process.env.OXBIT_NATIVE_BINARY ||
  path.join(root, "apps/desktop/src-tauri/target/debug/oxbit-desktop");
export const config = {
  specs: ["./workbench.e2e.mjs"],
  maxInstances: 1,
  logLevel: "warn",
  waitforTimeout: 30000,
  capabilities: [
    { browserName: "tauri", "tauri:options": { application: binary } },
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: binary,
        driverProvider: "embedded",
        embeddedPort: 4457,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        logDir: path.join(root, "apps/desktop/native-results"),
        startTimeout: 60000,
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { timeout: 90000 },
  outputDir: path.join(root, "apps/desktop/native-results"),
  afterTest: async (test, _context, result) => {
    if (!result.passed)
      await globalThis.browser
        .saveScreenshot(
          path.join(
            root,
            "apps/desktop/native-results",
            test.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 100) + ".png",
          ),
        )
        .catch(() => {});
  },
  onComplete: async () => {
    await fs.rm(fixture, { recursive: true, force: true });
  },
};
