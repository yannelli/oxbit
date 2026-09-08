import * as fs from "node:fs/promises";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
const tag = process.env.VERSION_TAG;
const version = JSON.parse(
  await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;
if (tag !== `v${version}`)
  throw new Error("Version tag does not match root package version");
const repo = "yannelli/oxbit";
const existing = spawnSync(
  "gh",
  ["release", "view", tag, "--repo", repo, "--json", "isDraft"],
  { encoding: "utf8" },
);
if (existing.status === 0 && !JSON.parse(existing.stdout).isDraft)
  throw new Error("Refusing to replace assets on a published release");
if (existing.status !== 0)
  execFileSync(
    "gh",
    [
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--draft",
      "--title",
      `Oxbit ${version}`,
      "--generate-notes",
    ],
    { stdio: "inherit" },
  );
const assets = [];
async function walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) await walk(file);
    else if (/\.(dmg|deb|AppImage|sig|app\.tar\.gz)$/.test(file))
      assets.push(file);
  }
}
await walk("desktop-artifacts");
if (
  !assets.some((file) => file.endsWith(".dmg")) ||
  !assets.some((file) => file.endsWith(".deb")) ||
  !assets.some((file) => file.endsWith(".AppImage"))
)
  throw new Error("Both platform installers are required");
execFileSync(
  "gh",
  ["release", "upload", tag, "--repo", repo, "--clobber", ...assets],
  { stdio: "inherit" },
);
execFileSync(
  process.execPath,
  ["scripts/desktop/manifest.mjs", "desktop-artifacts"],
  { stdio: "inherit" },
);
execFileSync(
  "gh",
  [
    "release",
    "upload",
    tag,
    "--repo",
    repo,
    "--clobber",
    "desktop-artifacts/latest.json",
  ],
  { stdio: "inherit" },
);
