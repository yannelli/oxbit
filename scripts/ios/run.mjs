import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const crate = fileURLToPath(new URL("../../apps/ios/src-tauri/", import.meta.url));
const run = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
const tauri = (...args) =>
  run("bun", ["run", "--cwd", "apps/ios", "tauri", "--", ...args]);
const buildDir = fileURLToPath(new URL("../../apps/ios/src-tauri/gen/apple/build/", import.meta.url));
const profileDir = `${process.env.HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles`;
const config = JSON.parse(readFileSync(new URL("../../apps/ios/src-tauri/tauri.conf.json", import.meta.url)));
const liveActivity = `${config.identifier}.LiveActivity`;
const pbxproj = new URL("../../apps/ios/src-tauri/gen/apple/oxbit-ios.xcodeproj/project.pbxproj", import.meta.url);
const extensionProfile = (name) => `"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]" = "${name}";`;

function readProfile(path) {
  let plist;
  try {
    plist = execFileSync("security", ["cms", "-D", "-i", path], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return undefined;
  }
  const read = (key) => {
    try {
      return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, "/dev/stdin"], { input: plist, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
    } catch {
      return undefined;
    }
  };
  const devices = read(":ProvisionedDevices");
  return {
    name: read(":Name"),
    uuid: read(":UUID"),
    appId: read(":Entitlements:application-identifier"),
    getTaskAllow: read(":Entitlements:get-task-allow"),
    devices: devices ? devices.split("\n").length - 2 : 0,
    expires: new Date(read(":ExpirationDate")),
  };
}

// Ad hoc profiles carry a device list and get-task-allow false; development profiles set it true.
function adHocProfile(identifier) {
  if (!existsSync(profileDir)) return undefined;
  return readdirSync(profileDir)
    .filter((name) => name.endsWith(".mobileprovision"))
    .map((file) => readProfile(`${profileDir}/${file}`))
    .filter((profile) => profile?.appId?.endsWith(`.${identifier}`) && profile.getTaskAllow === "false" && profile.devices && profile.expires >= new Date())
    .sort((a, b) => b.expires - a.expires)[0];
}

// Decodes a base64 profile from the environment and installs it where Xcode looks for profiles.
function installProfile(variable, identifier) {
  if (!process.env[variable]) throw new Error(`Set ${variable} to the base64 App Store profile for ${identifier}`);
  const data = Buffer.from(process.env[variable], "base64");
  const directory = mkdtempSync(join(tmpdir(), "oxbit-profile-"));
  writeFileSync(join(directory, "profile.mobileprovision"), data);
  const profile = readProfile(join(directory, "profile.mobileprovision"));
  rmSync(directory, { recursive: true, force: true });
  if (!profile?.uuid || !profile.appId?.endsWith(`.${identifier}`))
    throw new Error(`${variable} is not a provisioning profile for ${identifier}`);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(`${profileDir}/${profile.uuid}.mobileprovision`, data);
  return profile;
}

// The Tauri CLI deletes the keychain it imports IOS_CERTIFICATE into when it exits, so the export
// imports the identity again. Without IOS_CERTIFICATE the export uses the login keychain.
function withSigningKeychain(callback) {
  if (!process.env.IOS_CERTIFICATE) return callback();
  const quiet = (args) => execFileSync("security", args, { stdio: ["ignore", "ignore", "inherit"] });
  const directory = mkdtempSync(join(tmpdir(), "oxbit-signing-"));
  const keychain = join(directory, "signing.keychain-db");
  const certificate = join(directory, "certificate.p12");
  const password = randomBytes(16).toString("hex");
  const searchList = execFileSync("security", ["list-keychains", "-d", "user"]).toString()
    .split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
  writeFileSync(certificate, Buffer.from(process.env.IOS_CERTIFICATE, "base64"));
  try {
    quiet(["create-keychain", "-p", password, keychain]);
    quiet(["set-keychain-settings", "-t", "3600", "-u", keychain]);
    quiet(["unlock-keychain", "-p", password, keychain]);
    quiet(["import", certificate, "-k", keychain, "-P", process.env.IOS_CERTIFICATE_PASSWORD ?? "", "-T", "/usr/bin/codesign"]);
    quiet(["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]);
    quiet(["list-keychains", "-d", "user", "-s", keychain, ...searchList]);
    return callback();
  } finally {
    quiet(["list-keychains", "-d", "user", "-s", ...searchList]);
    if (existsSync(keychain)) quiet(["delete-keychain", keychain]);
    rmSync(directory, { recursive: true, force: true });
  }
}

function exportOptions(method, profiles) {
  const entries = {
    method,
    teamID: process.env.APPLE_TEAM_ID ?? config.bundle.iOS.developmentTeam,
    signingStyle: "manual",
    signingCertificate: "Apple Distribution",
  };
  const strings = Object.entries(entries)
    .filter(([, value]) => value)
    .map(([key, value]) => `  <key>${key}</key><string>${value}</string>`)
    .join("\n");
  const profileEntries = Object.entries(profiles)
    .map(([identifier, profile]) => `    <key>${identifier}</key><string>${profile}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${strings}
  <key>provisioningProfiles</key>
  <dict>
${profileEntries}
  </dict>
  <key>stripSwiftSymbols</key><true/>
  <key>uploadSymbols</key><${method === "app-store-connect"}/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
`;
}

// The CLI's ExportOptions map names only the app's profile, so it cannot sign the Live Activity
// extension. Export from the archive with a profile for each bundle.
function exportArchive(method, profiles, file) {
  const options = join(buildDir, file);
  writeFileSync(options, exportOptions(method, profiles));
  run("xcodebuild", ["-exportArchive", "-archivePath", "oxbit-ios_iOS.xcarchive", "-exportOptionsPlist", options, "-exportPath", "./arm64"], buildDir);
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
// The Tauri CLI spawns xcodebuild with only HOME, PATH, and TERM. The shims restore DEVELOPER_DIR.
process.env.PATH = fileURLToPath(new URL("./xcode-shim", import.meta.url)) + ":" + process.env.PATH;
if (mode === "init") tauri("ios", "init", ...extra);
if (["dev", "build", "adhoc", "simulator"].includes(mode)) run("bun", ["run", "build:example"]);
if (mode === "dev") tauri("ios", "dev", ...extra);
if (mode === "build") {
  const app = installProfile("IOS_MOBILE_PROVISION", config.identifier);
  const extension = installProfile("IOS_LIVE_ACTIVITY_PROVISION", liveActivity);
  tauri("ios", "build", "--archive-only", ...extra);
  withSigningKeychain(() =>
    exportArchive("app-store-connect", { [config.identifier]: app.uuid, [liveActivity]: extension.uuid }, "AppStoreExportOptions.plist"),
  );
  console.log(`Exported with profiles "${app.name}" and "${extension.name}"`);
}
if (mode === "adhoc") {
  const profile = adHocProfile(config.identifier);
  if (!profile) throw new Error(`Install an ad hoc profile for ${config.identifier} under ${profileDir}`);
  const extension = adHocProfile(liveActivity);
  if (!extension) throw new Error(`Install an ad hoc profile for ${liveActivity} under ${profileDir}`);
  // The extension's release configuration names the App Store profile, whose certificate is the CI
  // identity. Archive the extension with its ad hoc profile, then restore the project file.
  const project = readFileSync(pbxproj, "utf8");
  const appStore = extensionProfile("Oxbit CI Live Activity App Store");
  if (!project.includes(appStore)) throw new Error(`The Xcode project has no ${appStore}`);
  writeFileSync(pbxproj, project.replace(appStore, extensionProfile(extension.name)));
  try {
    tauri("ios", "build", "--archive-only", ...extra);
  } finally {
    writeFileSync(pbxproj, project);
  }
  exportArchive("release-testing", { [config.identifier]: profile.name, [liveActivity]: extension.name }, "AdHocExportOptions.plist");
  console.log(`Exported with profiles "${profile.name}" and "${extension.name}" covering ${profile.devices} device(s)`);
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
  run("node", ["scripts/ios/language-server-notices.mjs", "--check"]);
  const nativeTests = mkdtempSync(join(tmpdir(), "oxbit-ios-language-"));
  try {
    const binary = join(nativeTests, "language-server-files");
    run("swiftc", [
      "apps/ios/plugins/oxbit-files/ios/Sources/LanguageServerFiles.swift",
      "apps/ios/plugins/oxbit-files/ios/Tests/LanguageServerFiles/main.swift",
      "-o", binary,
    ]);
    run(binary, []);
    const sshKeys = join(nativeTests, "ssh-keys");
    run("swiftc", [
      "apps/ios/plugins/oxbit-files/ios/Sources/SshKeyStore.swift",
      "apps/ios/plugins/oxbit-files/ios/Tests/SshKeys/main.swift",
      "-o", sshKeys,
    ]);
    run(sshKeys, []);
    const profileTests = join(nativeTests, "git-credential-profile");
    run("swiftc", [
      "apps/ios/plugins/oxbit-files/ios/Sources/GitCredentialProfile.swift",
      "apps/ios/plugins/oxbit-files/ios/Tests/GitCredentialProfile/main.swift",
      "-o", profileTests,
    ]);
    run(profileTests, []);
    const runtimeDownload = join(nativeTests, "runtime-download");
    run("swiftc", [
      "apps/ios/plugins/oxbit-files/ios/Sources/RuntimeDownloadStore.swift",
      "apps/ios/plugins/oxbit-files/ios/Tests/RuntimeDownload/main.swift",
      "-o", runtimeDownload,
    ]);
    run(runtimeDownload, []);
    const schemaCache = join(nativeTests, "schema-cache");
    run("swiftc", [
      "apps/ios/plugins/oxbit-files/ios/Sources/SchemaCache.swift",
      "apps/ios/plugins/oxbit-files/ios/Tests/SchemaCache/main.swift",
      "-o", schemaCache,
    ]);
    run(schemaCache, []);
    const bundles = join(nativeTests, "language-server-bundle");
    run("swiftc", [
      "apps/ios/plugins/oxbit-files/ios/Sources/LanguageServerFiles.swift",
      "apps/ios/plugins/oxbit-files/ios/Sources/SchemaCache.swift",
      "apps/ios/plugins/oxbit-files/ios/Sources/LanguageServerRuntime.swift",
      "apps/ios/plugins/oxbit-files/ios/Tests/LanguageServerBundle/main.swift",
      "-o", bundles,
    ]);
    // iOS app contexts run without the JIT.
    run(bundles, ["apps/ios/src-tauri/gen/apple/assets/language-servers"], undefined, { ...process.env, JSC_useJIT: "0" });
  } finally {
    rmSync(nativeTests, { recursive: true, force: true });
  }
  run("cargo", ["fmt", "--all", "--", "--check"], crate);
  run("cargo", ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"], crate);
  run("cargo", ["test", "--locked"], crate);
}
