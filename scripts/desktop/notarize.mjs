import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    dmg: { type: "string" },
    app: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Usage: node scripts/desktop/notarize.mjs [--dmg /path/to/Oxbit.dmg] [--app /path/to/Oxbit.app]

Requires APPLE_SIGNING_IDENTITY and either APPLE_KEYCHAIN_PROFILE (preferred locally)
or APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID (CI).
Without paths, uses CARGO_TARGET_DIR/release/bundle under apps/desktop/src-tauri.
The app must already be Developer ID signed. This command signs and notarizes the DMG.`);
  process.exit(0);
}
if (process.platform !== "darwin")
  throw new Error("Notarization requires macOS");
const required = ["APPLE_SIGNING_IDENTITY"];
if (!process.env.APPLE_KEYCHAIN_PROFILE)
  required.push("APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID");
for (const key of required)
  if (!process.env[key]) throw new Error(`Notarization requires ${key}`);
const native = fileURLToPath(
  new URL("../../apps/desktop/src-tauri/", import.meta.url),
);
const root = path.join(
  path.resolve(native, process.env.CARGO_TARGET_DIR || "target"),
  "release/bundle",
);
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} failed; inspect the notarization result`);
};
const app = values.app
  ? path.resolve(values.app)
  : path.join(root, "macos/Oxbit.app");
const files = values.dmg
  ? [path.resolve(values.dmg)]
  : (await fs.readdir(path.join(root, "dmg")))
      .filter((name) => name.endsWith(".dmg"))
      .sort()
      .map((name) => path.join(root, "dmg", name));
if (!files.length) throw new Error("No DMG artifacts found to notarize");
for (const file of files) {
  if (path.extname(file) !== ".dmg" || !(await fs.stat(file)).isFile())
    throw new Error("Notarization input must be an existing .dmg file");
}
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const credentials = process.env.APPLE_KEYCHAIN_PROFILE
  ? ["--keychain-profile", process.env.APPLE_KEYCHAIN_PROFILE]
  : [
      "--apple-id",
      process.env.APPLE_ID,
      "--password",
      process.env.APPLE_PASSWORD,
      "--team-id",
      process.env.APPLE_TEAM_ID,
    ];
for (const file of files) {
  run("/usr/bin/codesign", [
    "--force",
    "--timestamp",
    "--sign",
    process.env.APPLE_SIGNING_IDENTITY,
    file,
  ]);
  run("xcrun", [
    "notarytool",
    "submit",
    file,
    "--wait",
    "--timeout",
    "20m",
    ...credentials,
  ]);
  run("xcrun", ["stapler", "staple", file]);
  run("xcrun", ["stapler", "validate", file]);
  run("/usr/bin/codesign", ["--verify", "--strict", file]);
  run("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=2",
    file,
  ]);
}
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
