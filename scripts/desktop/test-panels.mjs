import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Tauri rejects executable paths containing symlinks (including macOS /var).
const temporary = mkdtempSync(
  path.join(realpathSync(os.tmpdir()), "oxbit-native-panels-"),
);
const contents = path.join(temporary, "Oxbit Panel Test.app", "Contents");
mkdirSync(path.join(contents, "MacOS"), { recursive: true });
mkdirSync(path.join(contents, "Resources"), { recursive: true });
symlinkSync(
  path.join(root, "apps/desktop/src-tauri/resources/runtime"),
  path.join(contents, "Resources/runtime"),
);
writeFileSync(
  path.join(contents, "Info.plist"),
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>oxbit-desktop</string><key>CFBundleIdentifier</key><string>com.yannelli.oxbit.panel-test</string><key>CFBundleName</key><string>Oxbit Panel Test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
);
const binary = path.join(contents, "MacOS/oxbit-desktop");
const configuration = {
  identifier: "com.yannelli.oxbit.panel-test",
  app: {
    withGlobalTauri: true,
    security: {
      capabilities: [
        "desktop",
        {
          identifier: "native-tests",
          windows: ["main", "project-*"],
          permissions: ["wdio:default", "core:window:allow-get-all-windows"],
        },
      ],
    },
  },
};
try {
  execFileSync("bun", ["run", "--filter", "@oxbit/desktop", "build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_DESKTOP_TEST: "1" },
  });
  execFileSync("cargo", ["build", "--locked", "--features", "native-test"], {
    cwd: path.join(root, "apps/desktop/src-tauri"),
    stdio: "inherit",
    env: { ...process.env, TAURI_CONFIG: JSON.stringify(configuration) },
  });
  // Other desktop work can rebuild target/debug while this test is running.
  copyFileSync(
    path.join(root, "apps/desktop/src-tauri/target/debug/oxbit-desktop"),
    binary,
  );
  execFileSync(
    "bun",
    ["x", "wdio", "run", "tests/desktop/panels.wdio.conf.mjs"],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, OXBIT_NATIVE_BINARY: binary },
    },
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
