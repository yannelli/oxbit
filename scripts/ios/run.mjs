import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const crate = fileURLToPath(new URL("../../apps/ios/src-tauri/", import.meta.url));
const run = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
const tauri = (...args) => run("pnpm", ["--filter", "@oxbit/ios", "exec", "tauri", ...args]);
const mode = process.argv[2];
const extra = process.argv.slice(3);
if (process.platform !== "darwin") throw new Error("iOS builds need macOS with Xcode");
if (!["init", "dev", "build", "check", "simulator", "upload"].includes(mode))
  throw new Error("Choose init, dev, build, check, simulator, or upload");
// xcode-select on this machine points at the Command Line Tools; iOS builds need the full Xcode.
if (!process.env.DEVELOPER_DIR) {
  const selected = execFileSync("xcode-select", ["-p"]).toString().trim();
  const beta = "/Applications/Xcode-beta.app/Contents/Developer";
  const stable = "/Applications/Xcode.app/Contents/Developer";
  if (!selected.includes(".app/")) process.env.DEVELOPER_DIR = existsSync(stable) ? stable : beta;
}
// The Tauri CLI spawns xcodebuild with only HOME, PATH, and TERM; the shims restore DEVELOPER_DIR.
process.env.PATH = fileURLToPath(new URL("./xcode-shim", import.meta.url)) + ":" + process.env.PATH;
if (mode === "init") tauri("ios", "init", ...extra);
if (["dev", "build", "simulator"].includes(mode)) run("pnpm", ["build:example"]);
if (mode === "dev") tauri("ios", "dev", ...extra);
if (mode === "build") tauri("ios", "build", "--export-method", "app-store-connect", ...extra);
if (mode === "simulator") {
  // The CLI moves the archive product into place and fails when a previous build is still there.
  rmSync(new URL("../../apps/ios/src-tauri/gen/apple/build/arm64-sim", import.meta.url), { recursive: true, force: true });
  tauri("ios", "build", "--debug", "--target", "aarch64-sim", "--no-sign", ...extra);
}
if (mode === "upload") {
  const ipa = extra[0];
  if (!ipa) throw new Error("Pass the IPA path");
  for (const name of ["APPLE_API_KEY", "APPLE_API_ISSUER"])
    if (!process.env[name]) throw new Error(`Set ${name}`);
  run("xcrun", ["altool", "--upload-app", "-t", "ios", "-f", ipa, "--apiKey", process.env.APPLE_API_KEY, "--apiIssuer", process.env.APPLE_API_ISSUER]);
}
if (mode === "check") {
  run("pnpm", ["--filter", "@oxbit/ios", "build"]);
  run("cargo", ["fmt", "--all", "--", "--check"], crate);
  run("cargo", ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"], crate);
  run("cargo", ["test", "--locked"], crate);
}
