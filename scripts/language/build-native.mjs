import { readFile, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
const root = process.cwd();
const env = { ...process.env, VITE_DESKTOP_TEST: "1", MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET ?? "26.0" };
execFileSync("pnpm", ["--filter", "@oxbit/desktop", "exec", "vite", "build", "--outDir", "dist-language-tests"], { cwd: root, env, stdio: "inherit" });
const config = JSON.parse(await readFile("apps/desktop/src-tauri/tauri.native-test.conf.json", "utf8"));
config.identifier = "com.yannelli.oxbit.language-test"; config.build = { frontendDist: "../dist-language-tests" };
execFileSync("cargo", ["build", "--locked", "--features", "native-test,custom-protocol"], { cwd: path.join(root, "apps/desktop/src-tauri"), env: { ...env, TAURI_CONFIG: JSON.stringify(config) }, stdio: "inherit" });
await copyFile("apps/desktop/src-tauri/target/debug/oxbit-desktop", "apps/desktop/src-tauri/target/debug/oxbit-language-test");

