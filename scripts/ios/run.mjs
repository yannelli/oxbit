import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const crate = fileURLToPath(new URL("../../apps/ios/src-tauri/", import.meta.url));
const run = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
const tauri = (...args) =>
  run("bun", ["run", "--filter", "@oxbit/ios", "tauri", "--", ...args]);
const buildDir = fileURLToPath(new URL("../../apps/ios/src-tauri/gen/apple/build/", import.meta.url));
const profileDir = `${process.env.HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles`;

// Ad hoc profiles carry a device list and get-task-allow false; development profiles set it true.
function adHocProfile(identifier) {
  if (!existsSync(profileDir)) return undefined;
  const found = [];
  for (const file of readdirSync(profileDir).filter((name) => name.endsWith(".mobileprovision"))) {
    const path = `${profileDir}/${file}`;
    let plist;
    try {
      plist = execFileSync("security", ["cms", "-D", "-i", path], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch {
      continue;
    }
    const read = (key) => {
      try {
        return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, "/dev/stdin"], { input: plist, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
      } catch {
        return undefined;
      }
    };
    const appId = read(":Entitlements:application-identifier");
    if (!appId?.endsWith(`.${identifier}`)) continue;
    if (read(":Entitlements:get-task-allow") !== "false") continue;
    const devices = read(":ProvisionedDevices");
    if (!devices) continue;
    const expires = new Date(read(":ExpirationDate"));
    if (expires < new Date()) continue;
    found.push({ name: read(":Name"), expires, devices: devices.split("\n").length - 2 });
  }
  return found.sort((a, b) => b.expires - a.expires)[0];
}

function exportOptions(identifier, profile) {
  const entries = {
    method: "release-testing",
    teamID: process.env.APPLE_TEAM_ID ?? "",
    signingStyle: "manual",
    signingCertificate: "Apple Distribution",
  };
  const strings = Object.entries(entries)
    .filter(([, value]) => value)
    .map(([key, value]) => `  <key>${key}</key><string>${value}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${strings}
  <key>provisioningProfiles</key>
  <dict>
    <key>${identifier}</key><string>${profile}</string>
  </dict>
  <key>stripSwiftSymbols</key><true/>
  <key>uploadSymbols</key><false/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
`;
}

const mode = process.argv[2];
const extra = process.argv.slice(3);
if (process.platform !== "darwin") throw new Error("iOS builds need macOS with Xcode");
if (!["init", "dev", "build", "adhoc", "check", "simulator", "upload"].includes(mode))
  throw new Error("Choose init, dev, build, adhoc, check, simulator, or upload");
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
if (["dev", "build", "adhoc", "simulator"].includes(mode)) run("bun", ["run", "build:example"]);
if (mode === "dev") tauri("ios", "dev", ...extra);
const exportMethod = extra.includes("--export-method") ? [] : ["--export-method", "app-store-connect"];
if (mode === "build") tauri("ios", "build", ...exportMethod, ...extra);
if (mode === "adhoc") {
  const identifier = JSON.parse(readFileSync(new URL("../../apps/ios/src-tauri/tauri.conf.json", import.meta.url))).identifier;
  const profile = adHocProfile(identifier);
  if (!profile) throw new Error(`Install an ad hoc profile for ${identifier} under ${profileDir}`);
  tauri("ios", "build", "--archive-only", ...extra);
  // The CLI writes signingStyle "manual" for release-testing without a provisioningProfiles map,
  // so its own export step cannot resolve a profile. Export from the archive instead.
  const options = new URL("../../apps/ios/src-tauri/gen/apple/build/AdHocExportOptions.plist", import.meta.url);
  writeFileSync(options, exportOptions(identifier, profile.name));
  run("xcodebuild", ["-exportArchive", "-archivePath", "oxbit-ios_iOS.xcarchive", "-exportOptionsPlist", fileURLToPath(options), "-exportPath", "./arm64"], buildDir);
  console.log(`Exported with profile "${profile.name}" covering ${profile.devices} device(s)`);
}
if (mode === "simulator") {
  // The CLI moves the archive product into place and fails when a previous build is still there.
  rmSync(new URL("../../apps/ios/src-tauri/gen/apple/build/arm64-sim", import.meta.url), { recursive: true, force: true });
  // Xcode embeds the simulator application identity needed for Keychain credentials.
  tauri("ios", "build", "--debug", "--target", "aarch64-sim", ...extra);
}
if (mode === "upload") {
  const ipa = extra[0];
  if (!ipa) throw new Error("Pass the IPA path");
  for (const name of ["APPLE_API_KEY", "APPLE_API_ISSUER"])
    if (!process.env[name]) throw new Error(`Set ${name}`);
  run("xcrun", ["altool", "--upload-app", "-t", "ios", "-f", ipa, "--apiKey", process.env.APPLE_API_KEY, "--apiIssuer", process.env.APPLE_API_ISSUER]);
}
if (mode === "check") {
  run("bun", ["run", "--filter", "@oxbit/ios", "build"]);
  run("cargo", ["fmt", "--all", "--", "--check"], crate);
  run("cargo", ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"], crate);
  run("cargo", ["test", "--locked"], crate);
}
