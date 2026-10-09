/** Copy the bundled remote payloads into the release directory with one combined manifest. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const remotePlatforms = ["darwin-arm64", "linux-x64", "linux-arm64"];

export async function buildReleaseManifest(directories, version) {
  const found = {};
  for (const directory of directories) {
    const source = JSON.parse(
      await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
    );
    for (const [platform, entry] of Object.entries(source.platforms ?? {})) {
      if (!remotePlatforms.includes(platform))
        throw new Error(`Unsupported remote platform: ${platform}`);
      if (found[platform])
        throw new Error(`Duplicate remote platform: ${platform}`);
      const archive = path.join(directory, `${platform}.tar.gz`);
      const bytes = await fs.readFile(archive);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== entry.sha256)
        throw new Error(`Remote payload checksum mismatch: ${platform}`);
      found[platform] = { archive, sha256, size: bytes.length };
    }
  }
  const missing = remotePlatforms.filter((platform) => !found[platform]);
  if (missing.length)
    throw new Error(`Missing remote payloads: ${missing.join(", ")}`);
  return {
    archives: Object.fromEntries(
      remotePlatforms.map((platform) => [platform, found[platform].archive]),
    ),
    manifest: {
      version,
      platforms: Object.fromEntries(
        remotePlatforms.map((platform) => [
          platform,
          { sha256: found[platform].sha256, size: found[platform].size },
        ]),
      ),
    },
  };
}

export async function writeReleaseAssets(output, directories, version) {
  const { archives, manifest } = await buildReleaseManifest(
    directories,
    version,
  );
  await fs.mkdir(output, { recursive: true });
  for (const [platform, archive] of Object.entries(archives))
    await fs.copyFile(
      archive,
      path.join(output, `remote-runtime-${platform}.tar.gz`),
    );
  await fs.writeFile(
    path.join(output, "remote-runtime-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [output, ...directories] = process.argv.slice(2);
  if (!output || !directories.length)
    throw new Error(
      "Usage: node scripts/remote/release-manifest.mjs <output> <payload-directory>...",
    );
  const { version } = JSON.parse(
    await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const manifest = await writeReleaseAssets(
    path.resolve(output),
    directories.map((directory) => path.resolve(directory)),
    version,
  );
  console.log(JSON.stringify(manifest, null, 2));
}
