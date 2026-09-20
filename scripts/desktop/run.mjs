import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const run = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
const mode = process.argv[2];
if (process.platform === "darwin")
  process.env.MACOSX_DEPLOYMENT_TARGET ??= "26.0";
if (!["dev", "build", "native-build", "check"].includes(mode))
  throw new Error("Choose dev, build, native-build, or check");
if (
  !["darwin-arm64", "linux-x64"].includes(`${process.platform}-${process.arch}`)
)
  throw new Error("Desktop builds support macOS arm64 and Ubuntu 24.04 x64");
if (mode !== "check") {
  run(process.execPath, ["scripts/desktop/prepare.mjs"]);
  run(process.execPath, ["scripts/desktop/smoke-runtime.mjs"]);
  run("bun", ["run", "build:example"]);
  run(process.execPath, ["scripts/desktop/licenses.mjs"]);
}
if (mode === "dev")
  run("bun", [
    "run",
    "--cwd",
    "apps/desktop",
    "tauri",
    "--",
    "dev",
    "--no-default-features",
  ]);
if (mode === "native-build")
  run(
    "bun",
    [
      "run",
      "--cwd",
      "apps/desktop",
      "tauri",
      "--",
      "build",
      "--debug",
      "--features",
      "native-test",
      "--config",
      "src-tauri/tauri.native-test.conf.json",
      "--no-bundle",
    ],
    root,
    { ...process.env, VITE_DESKTOP_TEST: "1" },
  );
if (mode === "build") {
  if (process.platform === "linux") {
    run(process.execPath, ["scripts/desktop/bundle-tools.mjs"]);
    process.env.APPIMAGE_EXTRACT_AND_RUN ??= "1";
  }
  if (process.env.VITE_DESKTOP_TEST)
    throw new Error(
      "Unset VITE_DESKTOP_TEST before building distribution artifacts",
    );
  const release = process.argv.includes("--release");
  if (release) run(process.execPath, ["scripts/desktop/release-config.mjs"]);
  if (process.platform === "darwin")
    run(process.execPath, [
      "scripts/desktop/sign-resources.mjs",
      ...(release ? ["--release"] : []),
    ]);
  run("bun", [
    "run",
    "--cwd",
    "apps/desktop",
    "tauri",
    "--",
    "build",
    "--bundles",
    process.platform === "darwin" ? "app,dmg" : "deb,appimage",
    ...(release ? ["--config", "src-tauri/tauri.release.conf.json"] : []),
  ]);
  run(process.execPath, [
    "scripts/desktop/validate.mjs",
    ...(release ? ["--release"] : []),
  ]);
}
if (mode === "check") {
  run("bun", ["run", "--filter", "@oxbit/desktop", "build"]);
  const cwd = fileURLToPath(
    new URL("../../apps/desktop/src-tauri/", import.meta.url),
  );
  run("cargo", ["fmt", "--all", "--", "--check"], cwd);
  run(
    "cargo",
    ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"],
    cwd,
  );
  run("cargo", ["test", "--locked"], cwd);
}
