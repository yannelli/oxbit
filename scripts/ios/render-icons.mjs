import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalogDir = join(root, "apps/ios/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset");
const releaseDir = join(root, "design/releases/v0.3.1/icons");
const sourcePath = join(catalogDir, "AppIcon-512@2x.png");
const source = await readFile(sourcePath);
const baselineSha256 = "1163a462e1f20d49ae2db0c23bc86bdaef1a174eb92c85cade40133a94cd3fd8";
if (createHash("sha256").update(source).digest("hex") !== baselineSha256) {
  throw new Error("The app icon differs from the approved v0.3.0-alpha.5 artwork");
}
if (execFileSync("magick", [sourcePath, "-format", "%[opaque]", "info:"], { encoding: "utf8" }).trim() !== "True") {
  throw new Error("The established app icon must be opaque");
}
const png = execFileSync("magick", [sourcePath, "-alpha", "off", "-type", "TrueColor", "PNG24:-"], {
  maxBuffer: 16 * 1024 * 1024,
});
if (png.readUInt32BE(16) !== 1024 || png.readUInt32BE(20) !== 1024 || png[25] !== 2) {
  throw new Error("Invalid opaque RGB icon export");
}
await mkdir(releaseDir, { recursive: true });
await writeFile(join(releaseDir, "oxbit-ios-default.png"), png);
await writeFile(join(releaseDir, "oxbit-ios-default.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title"><title id="title">Oxbit app icon</title><image width="1024" height="1024" href="data:image/png;base64,${png.toString("base64")}"/></svg>\n`);
for (const appearance of ["dark", "tinted"]) {
  for (const extension of ["svg", "png"]) {
    await rm(join(releaseDir, `oxbit-ios-${appearance}.${extension}`), { force: true });
  }
}
console.log("Exported the unchanged alpha.5 icon; native app assets were not modified.");
