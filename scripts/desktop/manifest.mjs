import * as fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
const directory = path.resolve(process.argv[2] || "desktop-artifacts");
const pkg = JSON.parse(
  await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const tag = `v${pkg.version}`;
const published = JSON.parse(
  execFileSync(
    "gh",
    ["release", "view", tag, "--repo", "yannelli/oxbit", "--json", "assets"],
    { encoding: "utf8" },
  ),
);
const names = new Set(published.assets.map((asset) => asset.name));
const all = [];
async function walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) await walk(file);
    else all.push(file);
  }
}
await walk(directory);
const platforms = {};
for (const [platform, suffix] of [
  ["darwin-aarch64", ".app.tar.gz"],
  ["linux-x86_64", ".AppImage"],
]) {
  const file = all.find((file) => file.endsWith(suffix));
  if (!file || !names.has(path.basename(file)))
    throw new Error(
      `Upload the ${platform} artifact before generating its manifest`,
    );
  const signature = (await fs.readFile(file + ".sig", "utf8")).trim();
  if (!signature) throw new Error(`Missing ${platform} updater signature`);
  platforms[platform] = {
    signature,
    url: `https://github.com/yannelli/oxbit/releases/download/${tag}/${encodeURIComponent(path.basename(file))}`,
  };
}
await fs.writeFile(
  path.join(directory, "latest.json"),
  JSON.stringify(
    {
      version: pkg.version,
      notes: `Oxbit ${pkg.version}`,
      pub_date: new Date().toISOString(),
      platforms,
    },
    null,
    2,
  ) + "\n",
);
