import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = join(root, "apps/web/public/brand/oxbit-mark.svg");
const releaseDir = join(root, "design/releases/v0.3.1/icons");
const tauriDir = join(root, "apps/ios/src-tauri/icons");
const catalogDir = join(root, "apps/ios/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset");
const variants = [
  { name: "default", background: "#8bd5ca", mark: "#14161a", catalog: "AppIcon.png" },
  { name: "dark", background: "#14161a", mark: "#8bd5ca", catalog: "AppIcon-dark.png" },
  { name: "tinted", background: "#191919", mark: "#d9d9d9", catalog: "AppIcon-tinted.png" },
];
const tauriSizes = [
  { filename: "icon.png", size: 512 },
  { filename: "32x32.png", size: 32 },
  { filename: "128x128.png", size: 128 },
  { filename: "128x128@2x.png", size: 256 },
];

const source = await readFile(sourcePath, "utf8");
const paths = [...source.matchAll(/<path\b[^>]*\/>/g)].map(([path]) => path);
if (paths.length !== 2 || !source.includes('viewBox="0 0 64 64"')) {
  throw new Error(`Unexpected canonical mark: ${sourcePath}`);
}

function svg({ name, background, mark }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 64 64" role="img" aria-labelledby="title"><title id="title">Oxbit ${name} app icon</title><rect width="64" height="64" fill="${background}"/><g fill="${mark}" transform="translate(32 32) scale(1.08) translate(-32 -32)">${paths.join("")}</g></svg>\n`;
}

async function render(page, artwork, size, rgba = false) {
  const base64 = await page.evaluate(async ({ artwork, size }) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artwork)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, size, size);
    const pixels = context.getImageData(0, 0, size, size).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 255) throw new Error("App icon contains transparency");
    }
    return canvas.toDataURL("image/png").split(",")[1];
  }, { artwork, size });
  const canvasPng = Buffer.from(base64, "base64");
  const png = rgba ? canvasPng : execFileSync("magick", ["png:-", "-alpha", "off", "-type", "TrueColor", "PNG24:-"], {
    input: canvasPng,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size || png[25] !== (rgba ? 6 : 2)) {
    throw new Error(`Invalid ${rgba ? "RGBA" : "RGB"} icon export: ${size}`);
  }
  return png;
}

await Promise.all([mkdir(releaseDir, { recursive: true }), mkdir(tauriDir, { recursive: true }), mkdir(catalogDir, { recursive: true })]);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const variant of variants) {
    const artwork = svg(variant);
    const master = await render(page, artwork, 1024);
    await writeFile(join(releaseDir, `oxbit-ios-${variant.name}.svg`), artwork);
    await writeFile(join(releaseDir, `oxbit-ios-${variant.name}.png`), master);
    await copyFile(join(releaseDir, `oxbit-ios-${variant.name}.png`), join(catalogDir, variant.catalog));
    if (variant.name === "default") {
      for (const { filename, size } of tauriSizes) {
        await writeFile(join(tauriDir, filename), await render(page, artwork, size, true));
      }
    }
  }
} finally {
  await browser.close();
}

const catalog = {
  images: variants.map(({ name, catalog }) => ({
    ...(name === "default" ? {} : { appearances: [{ appearance: "luminosity", value: name }] }),
    filename: catalog,
    idiom: "universal",
    platform: "ios",
    size: "1024x1024",
  })),
  info: { author: "xcode", version: 1 },
};
await writeFile(join(catalogDir, "Contents.json"), `${JSON.stringify(catalog, null, 2)}\n`);
for (const filename of await readdir(catalogDir)) {
  if (filename.endsWith(".png") && !variants.some(({ catalog }) => catalog === filename)) {
    await rm(join(catalogDir, filename));
  }
}
console.log("Rendered default, dark, and tinted iOS icons.");
