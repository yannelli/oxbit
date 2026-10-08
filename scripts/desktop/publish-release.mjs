import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
const directory = path.resolve(process.argv[2] || "release-files");
const tag = process.env.VERSION_TAG;
const version = JSON.parse(
  await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;
if (tag !== `v${version}`)
  throw new Error("Version tag does not match root package version");
const repo = "yannelli/oxbit";
const gh = (...args) =>
  execFileSync("gh", [...args, "--repo", repo], { stdio: "inherit" });
const existing = spawnSync(
  "gh",
  ["release", "view", tag, "--repo", repo, "--json", "isDraft"],
  { encoding: "utf8" },
);
if (existing.status === 0 && !JSON.parse(existing.stdout).isDraft)
  throw new Error("Refusing to replace assets on a published release");
const generated = ["latest.json", "SHA256SUMS"];
const files = (await fs.readdir(directory))
  .filter((name) => !generated.includes(name))
  .sort()
  .map((name) => path.join(directory, name));
for (const suffix of [
  ".dmg",
  ".app.tar.gz",
  ".app.tar.gz.sig",
  "_ios.ipa",
  "remote-runtime-darwin-arm64.tar.gz",
  "remote-runtime-linux-x64.tar.gz",
  "remote-runtime-manifest.json",
])
  if (!files.some((file) => file.endsWith(suffix)))
    throw new Error(`Missing release file *${suffix}`);
const prerelease = version.includes("-");
if (existing.status !== 0)
  gh(
    "release",
    "create",
    tag,
    "--draft",
    "--verify-tag",
    "--title",
    `Oxbit ${version}`,
    "--generate-notes",
    ...(prerelease ? ["--prerelease"] : []),
  );
// Binaries go up first; manifest.mjs checks the draft for them before writing latest.json.
gh("release", "upload", tag, "--clobber", ...files);
execFileSync(process.execPath, ["scripts/desktop/manifest.mjs", directory], {
  stdio: "inherit",
});
let sums = "";
for (const file of [...files, path.join(directory, "latest.json")].sort())
  sums += `${createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex")}  ${path.basename(file)}\n`;
await fs.writeFile(path.join(directory, "SHA256SUMS"), sums);
gh(
  "release",
  "upload",
  tag,
  "--clobber",
  ...generated.map((name) => path.join(directory, name)),
);
gh(
  "release",
  "edit",
  tag,
  "--draft=false",
  ...(prerelease ? [] : ["--latest"]),
);
