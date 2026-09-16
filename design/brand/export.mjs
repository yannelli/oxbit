import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const publicDir = path.join(root, "apps/web/public");
const brandDir = path.join(publicDir, "brand");
const type = JSON.parse(readFileSync(new URL("type-outlines.json", import.meta.url), "utf8"));
const mint = "#8bd5ca";
const ink = "#14161a";
const paper = "#f2f3ef";
const teal = "#0f7b6c";
const markPath = "M38 8H22C14.268 8 8 14.268 8 22V42C8 49.732 14.268 56 22 56H42C49.732 56 56 49.732 56 42V26H44V40C44 42.209 42.209 44 40 44H24C21.791 44 20 42.209 20 40V24C20 21.791 21.791 20 24 20H38Z";

function mark(color, transform = "") {
  return `<g fill="${color}"${transform ? ` transform="${transform}"` : ""}><path d="${markPath}"/><path d="M44 8H56V20H44Z"/></g>`;
}

function lettering(name, color, x, baseline, scale) {
  return `<path fill="${color}" transform="translate(${x} ${baseline}) scale(${scale})" d="${type[name].path}"/>`;
}

function svg(width, height, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">${title}</title>${body}</svg>\n`;
}

function write(name, contents, directory = brandDir) {
  writeFileSync(path.join(directory, name), contents);
}

function png(source, destination, width) {
  execFileSync("convert", ["-background", "none", "-density", "192", source, "-resize", `${width}x`, `PNG32:${destination}`]);
}

mkdirSync(brandDir, { recursive: true });
for (const [suffix, color] of [["", mint], ["-dark", ink], ["-light", paper], ["-teal", teal]]) {
  write(`oxbit-mark${suffix}.svg`, svg(64, 64, "Oxbit mark", mark(color)));
}

for (const [suffix, symbol, text] of [["", mint, paper], ["-dark", teal, ink], ["-mono", ink, ink], ["-white", paper, paper]]) {
  write(`oxbit-logo${suffix}.svg`, svg(560, 160, "Oxbit", mark(symbol, "translate(0 0) scale(2.5)") + lettering("wordmark", text, 188, 126, 0.13)));
}

for (const [suffix, color] of [["", paper], ["-dark", ink]]) {
  write(`oxbit-wordmark${suffix}.svg`, svg(384, 136, "Oxbit", lettering("wordmark", color, 12, 112, 0.13)));
}

function banner(width, height) {
  let grid = "";
  const left = width - 392;
  for (let i = 0; i <= 5; i++) {
    grid += `<path d="M${left + i * 64} 96V${height - 96}M${left} ${160 + i * 64}H${width - 72}"/>`;
  }
  return svg(width, height, "Oxbit — A code editor in your browser.",
    `<rect width="${width}" height="${height}" fill="${ink}"/>` +
    `<path d="M72 72H${width - 72}M72 ${height - 72}H${width - 72}" stroke="#30363b"/>` +
    `<g stroke="#263136" fill="none">${grid}</g>` +
    `<g fill="${mint}"><rect x="${left + 126}" y="222" width="4" height="4"/><rect x="${left + 254}" y="414" width="4" height="4"/></g>` +
    mark("#203632", `translate(${left + 4} ${height / 2 - 132}) scale(4)`) +
    `<path d="M${left + 180} ${height / 2 - 100}h48v48h-48z" fill="${mint}"/>` +
    mark(mint, `translate(40 ${height / 2 - 140}) scale(3.5)`) +
    lettering("wordmark", paper, 286, height / 2 + 27, 0.182) +
    lettering("descriptor", "#abb4b5", 291, height / 2 + 87, 0.023) +
    lettering("footer", "#91a4a3", 72, height - 37, 0.011));
}

function dmgBackground() {
  const width = 660;
  const height = 400;
  const app = { x: 180, y: 215 };
  const folder = { x: 480, y: 215 };
  let grid = "";
  for (let x = 60; x < width; x += 60) grid += `<path d="M${x} 0V${height}"/>`;
  for (let y = 50; y < height; y += 60) grid += `<path d="M0 ${y}H${width}"/>`;
  const slot = ({ x, y }) => `<rect x="${x - 76}" y="${y - 76}" width="152" height="152" rx="28"/>`;
  return svg(width, height, "Drag Oxbit to Applications",
    `<rect width="${width}" height="${height}" fill="${ink}"/>` +
    `<g stroke="#1c2226" fill="none">${grid}</g>` +
    `<g stroke="#2c3a3a" stroke-width="2" stroke-dasharray="6 8" fill="none">${slot(app)}${slot(folder)}</g>` +
    `<g stroke="${mint}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none">` +
    `<path d="M${app.x + 96} ${app.y}H${folder.x - 96}"/>` +
    `<path d="M${folder.x - 118} ${app.y - 20}L${folder.x - 96} ${app.y}L${folder.x - 118} ${app.y + 20}"/></g>` +
    `<g fill="${mint}"><rect x="118" y="348" width="4" height="4"/><rect x="598" y="58" width="4" height="4"/></g>` +
    mark(mint, "translate(36 30) scale(1)") +
    lettering("wordmark", paper, 114, 84, 0.055));
}

write("oxbit-github-banner.svg", banner(1280, 640));
write("oxbit-social-card.svg", banner(1200, 630));
write("oxbit-avatar.svg", svg(512, 512, "Oxbit app icon", `<rect width="512" height="512" fill="${ink}"/>${mark(mint, "translate(32 32) scale(7)")}`));

const favicon = svg(16, 16, "Oxbit", `<rect width="16" height="16" rx="3" fill="${ink}"/><g fill="${mint}"><path d="M9 2H6C3.791 2 2 3.791 2 6V10C2 12.209 3.791 14 6 14H10C12.209 14 14 12.209 14 10V7H11V10C11 10.552 10.552 11 10 11H6C5.448 11 5 10.552 5 10V6C5 5.448 5.448 5 6 5H9Z"/><path d="M11 2H14V5H11Z"/></g>`);
write("favicon.svg", favicon, publicDir);
for (const [name, width] of [["oxbit-github-banner", 1280], ["oxbit-social-card", 1200], ["oxbit-avatar", 512], ["oxbit-mark", 512], ["oxbit-logo", 1120], ["oxbit-logo-dark", 1120]]) {
  png(path.join(brandDir, `${name}.svg`), path.join(brandDir, `${name}.png`), width);
}
const dmgSvg = path.join(tmpdir(), "oxbit-dmg-background.svg");
writeFileSync(dmgSvg, dmgBackground());
execFileSync("convert", ["-background", "none", "-density", "288", dmgSvg, "-resize", "1320x", "-units", "PixelsPerInch", "-density", "144", `PNG32:${path.join(root, "apps/desktop/src-tauri/dmg-background.png")}`]);
for (const [name, width] of [["apple-touch-icon", 180], ["icon-192", 192], ["icon-512", 512]]) {
  png(path.join(brandDir, "oxbit-avatar.svg"), path.join(publicDir, `${name}.png`), width);
}
execFileSync("convert", ["-background", "none", "-density", "288", path.join(publicDir, "favicon.svg"), "-define", "icon:auto-resize=48,32,16", path.join(publicDir, "favicon.ico")]);
write("site.webmanifest", JSON.stringify({
  name: "Oxbit",
  short_name: "Oxbit",
  description: "A code editor in your browser.",
  start_url: "/",
  display: "standalone",
  background_color: ink,
  theme_color: ink,
  icons: [192, 512].map((size) => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any" })),
}, null, 2) + "\n", publicDir);
execFileSync("zip", ["-q", path.join(brandDir, "oxbit-brand-kit.zip"),
  ...readdirSync(brandDir).filter((name) => /\.(svg|png|html|js)$/.test(name)).map((name) => `brand/${name}`),
  "favicon.svg", "favicon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "site.webmanifest",
  "fonts/oxbit-font-0.woff2", "fonts/oxbit-font-3.woff2", "fonts/oxbit-font-4.woff2",
  "fonts/instrumentsans-OFL.txt", "fonts/jetbrainsmono-OFL.txt",
], { cwd: publicDir });
console.log("Exported Oxbit SVG, PNG, ICO, browser metadata, and ZIP kit.");
